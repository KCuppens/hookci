// Package scheduler decides which setup or job runs when. It owns the global
// slot pool, the per-env deploy locks and the supersede rules, and drives run
// and job state through the store. It never executes anything itself: an
// injected JobRunner does the work.
package scheduler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"slices"
	"strings"
	"sync"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// JobRunner executes one unit of work (setup or a job). It MUST return when
// ctx is cancelled; the scheduler cancels ctx on supersede, cancel and Close.
type JobRunner interface {
	// RunSetup runs the run's setup steps (checkout, caches, services, setup[]). It occupies one slot.
	RunSetup(ctx context.Context, run store.Run) error
	// RunJob runs one job and returns its terminal state (success|failed|cancelled) and exit code.
	RunJob(ctx context.Context, run store.Run, job store.Job) (JobOutcome, error)
	// FinishRun is called exactly once after the last job settles, for teardown (services, netns, proxy).
	FinishRun(ctx context.Context, run store.Run, final store.RunState) error
}

// JobOutcome is how a job ended.
type JobOutcome struct {
	State    store.JobState // success, failed or cancelled
	ExitCode int
	Reason   string   // e.g. "timeout", "exit 1", "superseded by <sha>"
	Tail     []string // last log lines; the store keeps them on failed events
	// LogsLocal marks a job whose log stays on the agent (`logs: local`); the
	// job's terminal event tells the hub so alerts say where the log is.
	LogsLocal bool
}

// Options configures a Scheduler.
type Options struct {
	Slots  int // <= 0 means DefaultSlots()
	Clock  Clock
	Logger *slog.Logger
}

var (
	ErrDeployNotCancellable = errors.New("scheduler: running deploy cannot be cancelled")
	ErrClosed               = errors.New("scheduler: closed")
)

// closedReason is recorded on runs and jobs that Close interrupts.
const closedReason = "scheduler closed"

// DefaultSlots returns max(1, runtime.NumCPU()/2).
func DefaultSlots() int {
	return max(1, runtime.NumCPU()/2)
}

// runState is the scheduler's view of one submitted run. Every field is
// guarded by Scheduler.mu except ctx, cancel and done, which never change.
type runState struct {
	run   store.Run
	jobs  map[string]store.Job
	graph *Graph
	key   string // SupersedeKey
	lock  string // EnvLockKey
	seq   uint64 // submission order

	ctx    context.Context
	cancel context.CancelFunc

	started   bool // queued -> running done; the run is in Scheduler.active
	setupDone bool
	running   int // setup or jobs in flight
	failedJob string

	// stopState is set when the run must end early: failed (supersede,
	// setup failure), cancelled (Cancel) or interrupted (Close). Queued jobs
	// then become stopJobs and stopReason is recorded on the run.
	stopState  store.RunState
	stopReason string
	stopJobs   store.JobState

	finishing bool // last work settled, FinishRun pending; terminal transition follows it
	final     store.RunState
	err       error
	done      chan struct{}
}

type workKind int

const (
	workSetup workKind = iota
	workJob
	workFinish
)

type result struct {
	rs   *runState
	kind workKind
	job  string
	dur  int64
	out  JobOutcome
	err  error
}

// Scheduler dispatches setups and jobs of submitted runs to a JobRunner.
type Scheduler struct {
	st     *store.Store
	runner JobRunner
	clock  Clock
	log    *slog.Logger

	base     context.Context
	stopAll  context.CancelFunc
	kick     chan struct{}
	results  chan result
	loopDone chan struct{}

	mu       sync.Mutex
	closed   bool
	free     int
	inflight int // worker goroutines not yet reported back
	seq      uint64
	runs     map[string]*runState // submitted and not yet finished
	queue    []*runState          // submitted, not started, in submission order
	active   []*runState          // started and not finishing, in start order
	envLocks map[string]string    // EnvLockKey -> run ID
	idle     chan struct{}
}

// New starts a scheduler over st that hands work to runner.
func New(st *store.Store, runner JobRunner, opts Options) *Scheduler {
	slots := opts.Slots
	if slots <= 0 {
		slots = DefaultSlots()
	}
	clock := opts.Clock
	if clock == nil {
		clock = RealClock{}
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	base, stopAll := context.WithCancel(context.Background())
	s := &Scheduler{
		st:       st,
		runner:   runner,
		clock:    clock,
		log:      logger,
		base:     base,
		stopAll:  stopAll,
		kick:     make(chan struct{}, 1),
		results:  make(chan result),
		loopDone: make(chan struct{}),
		free:     slots,
		runs:     make(map[string]*runState),
		envLocks: make(map[string]string),
	}
	go s.loop()
	return s
}

// Submit enqueues a run that already exists in the store in state queued with
// its jobs planned. It applies the supersede rules before enqueueing and
// returns the run IDs it superseded or cancelled.
func (s *Scheduler) Submit(ctx context.Context, runID string) (superseded []string, err error) {
	run, err := s.st.GetRun(ctx, runID)
	if err != nil {
		return nil, fmt.Errorf("scheduler: submit %s: %w", runID, err)
	}
	if run.State != store.RunQueued {
		return nil, fmt.Errorf("scheduler: submit %s: run is %s, not queued", runID, run.State)
	}
	jobs, err := s.st.Jobs(ctx, runID)
	if err != nil {
		return nil, fmt.Errorf("scheduler: submit %s: %w", runID, err)
	}
	g, err := NewGraph(jobs)
	if err != nil {
		return nil, fmt.Errorf("scheduler: submit %s: %w", runID, err)
	}
	queued, err := s.st.ListRuns(ctx, store.RunFilter{Repo: run.Repo, States: []store.RunState{store.RunQueued}})
	if err != nil {
		return nil, fmt.Errorf("scheduler: submit %s: %w", runID, err)
	}

	wctx := context.WithoutCancel(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrClosed
	}
	if _, dup := s.runs[runID]; dup {
		return nil, fmt.Errorf("scheduler: submit %s: already submitted", runID)
	}
	key := SupersedeKey(run)
	superseded, err = s.supersede(wctx, run, key, queued)
	if err != nil {
		return superseded, err
	}

	byName := make(map[string]store.Job, len(jobs))
	for _, j := range jobs {
		byName[j.Name] = j
	}
	rctx, cancel := context.WithCancel(s.base)
	s.seq++
	rs := &runState{
		run:    run,
		jobs:   byName,
		graph:  g,
		key:    key,
		lock:   EnvLockKey(run),
		seq:    s.seq,
		ctx:    rctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}
	s.runs[runID] = rs
	s.queue = append(s.queue, rs)
	s.wake()
	return superseded, nil
}

// supersede applies rules 4 to 7 for a new run with key. Queued runs this
// scheduler holds are older by submission order; queued runs only in the
// store are older by CreatedAt (then ID). Running PR checks are stopped;
// running pushes and deploys are left alone. The same SHA never supersedes.
func (s *Scheduler) supersede(ctx context.Context, run store.Run, key string, stored []store.Run) ([]string, error) {
	reason := "superseded by " + shortSHA(run.SHA)
	var out []string
	for _, old := range slices.Clone(s.queue) {
		if old.key != key || old.run.SHA == run.SHA {
			continue
		}
		if err := s.st.Supersede(ctx, old.run.ID, reason); err != nil {
			return out, fmt.Errorf("scheduler: supersede %s: %w", old.run.ID, err)
		}
		s.forget(old, store.RunSuperseded, nil)
		out = append(out, old.run.ID)
	}
	if strings.HasPrefix(key, "pr:") {
		for _, old := range slices.Clone(s.active) {
			if old.key != key || old.run.SHA == run.SHA || old.stopState != "" {
				continue
			}
			s.stop(old, store.RunFailed, reason, store.JobSkipped)
			out = append(out, old.run.ID)
		}
	}
	// ListRuns is newest first; supersede oldest first.
	for i := len(stored) - 1; i >= 0; i-- {
		old := stored[i]
		if old.ID == run.ID || old.SHA == run.SHA || SupersedeKey(old) != key || !createdBefore(old, run) {
			continue
		}
		if _, held := s.runs[old.ID]; held {
			continue
		}
		err := s.st.Supersede(ctx, old.ID, reason)
		if errors.Is(err, store.ErrStateMismatch) {
			continue // it left queued since ListRuns
		}
		if err != nil {
			return out, fmt.Errorf("scheduler: supersede %s: %w", old.ID, err)
		}
		out = append(out, old.ID)
	}
	return out, nil
}

func createdBefore(a, b store.Run) bool {
	if !a.CreatedAt.Equal(b.CreatedAt) {
		return a.CreatedAt.Before(b.CreatedAt)
	}
	return a.ID < b.ID
}

// Cancel cancels a run: queued -> cancelled; running -> running jobs
// cancelled, queued jobs skipped, run cancelled with reason. Deploy runs in
// running/verifying/rolling_back return ErrDeployNotCancellable. Cancelling a
// run that already ended or is already stopping is a no-op.
func (s *Scheduler) Cancel(ctx context.Context, runID, reason string) error {
	if reason == "" {
		reason = "cancelled"
	}
	wctx := context.WithoutCancel(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	rs, ok := s.runs[runID]
	if !ok {
		return s.cancelStored(wctx, runID, reason)
	}
	switch {
	case rs.finishing || rs.stopState != "":
		return nil
	case !rs.started:
		if err := s.st.Transition(wctx, runID, []store.RunState{store.RunQueued}, store.RunCancelled, reason); err != nil {
			return fmt.Errorf("scheduler: cancel %s: %w", runID, err)
		}
		s.forget(rs, store.RunCancelled, nil)
	case rs.run.Kind == kindDeploy:
		return ErrDeployNotCancellable
	default:
		s.stop(rs, store.RunCancelled, reason, store.JobSkipped)
	}
	s.wake()
	return nil
}

// cancelStored cancels a run this scheduler does not hold.
func (s *Scheduler) cancelStored(ctx context.Context, runID, reason string) error {
	run, err := s.st.GetRun(ctx, runID)
	if err != nil {
		return fmt.Errorf("scheduler: cancel %s: %w", runID, err)
	}
	switch {
	case run.Kind == kindDeploy && (run.State == store.RunRunning || run.State == store.RunVerifying || run.State == store.RunRollingBack):
		return ErrDeployNotCancellable
	case run.State == store.RunQueued:
		if err := s.st.Transition(ctx, runID, []store.RunState{store.RunQueued}, store.RunCancelled, reason); err != nil {
			return fmt.Errorf("scheduler: cancel %s: %w", runID, err)
		}
		return nil
	case run.State.Terminal():
		return nil
	default:
		return fmt.Errorf("scheduler: cancel %s: run is %s and not held by this scheduler", runID, run.State)
	}
}

// Wait blocks until runID reaches a terminal state and returns it. A run this
// scheduler does not hold is read from the store. The error reports a store
// write that failed while the run was driven.
func (s *Scheduler) Wait(ctx context.Context, runID string) (store.RunState, error) {
	s.mu.Lock()
	rs, ok := s.runs[runID]
	s.mu.Unlock()
	if !ok {
		run, err := s.st.GetRun(ctx, runID)
		if err != nil {
			return "", fmt.Errorf("scheduler: wait %s: %w", runID, err)
		}
		if !run.State.Terminal() {
			return "", fmt.Errorf("scheduler: wait %s: run is %s and was not submitted", runID, run.State)
		}
		return run.State, nil
	}
	select {
	case <-rs.done:
		return rs.final, rs.err
	case <-ctx.Done():
		return "", ctx.Err()
	case <-s.loopDone:
		select {
		case <-rs.done:
			return rs.final, rs.err
		default:
			return "", ErrClosed
		}
	}
}

// Idle blocks until no run is queued or running.
func (s *Scheduler) Idle(ctx context.Context) error {
	s.mu.Lock()
	if len(s.runs) == 0 {
		s.mu.Unlock()
		return nil
	}
	if s.idle == nil {
		s.idle = make(chan struct{})
	}
	ch := s.idle
	s.mu.Unlock()
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-s.loopDone:
		s.mu.Lock()
		defer s.mu.Unlock()
		if len(s.runs) == 0 {
			return nil
		}
		return ErrClosed
	}
}

// Close stops dispatching new work. Running work is cancelled through ctx and
// recorded as interrupted; queued runs stay queued in the store. Close returns
// once every runner call, including FinishRun, has returned.
func (s *Scheduler) Close() error {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		for _, rs := range slices.Clone(s.active) {
			s.stop(rs, store.RunInterrupted, closedReason, store.JobInterrupted)
		}
	}
	s.mu.Unlock()
	s.stopAll()
	s.wake()
	<-s.loopDone
	return nil
}

func (s *Scheduler) wake() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

func (s *Scheduler) loop() {
	defer close(s.loopDone)
	for {
		var res *result
		select {
		case <-s.kick:
		case r := <-s.results:
			res = &r
		}
		s.mu.Lock()
		if res != nil {
			s.apply(*res)
		}
		s.dispatch()
		exit := s.closed && s.inflight == 0
		s.mu.Unlock()
		if exit {
			return
		}
	}
}

// dispatch fills free slots: deploy jobs, deploy setups, check jobs, check
// setups, in that order.
func (s *Scheduler) dispatch() {
	for !s.closed && s.free > 0 {
		if rs, job := s.nextJob(true); rs != nil {
			s.startJob(rs, job)
		} else if rs := s.nextSetup(true); rs != nil {
			s.startSetup(rs)
		} else if rs, job := s.nextJob(false); rs != nil {
			s.startJob(rs, job)
		} else if rs := s.nextSetup(false); rs != nil {
			s.startSetup(rs)
		} else {
			return
		}
	}
}

func (s *Scheduler) nextJob(deploy bool) (*runState, string) {
	for _, rs := range s.active {
		if (rs.run.Kind == kindDeploy) != deploy || !rs.setupDone || rs.stopState != "" {
			continue
		}
		if ready := rs.graph.Ready(); len(ready) > 0 {
			return rs, ready[0]
		}
	}
	return nil, ""
}

func (s *Scheduler) nextSetup(deploy bool) *runState {
	var best *runState
	for _, rs := range s.queue {
		if (rs.run.Kind == kindDeploy) != deploy {
			continue
		}
		if _, held := s.envLocks[rs.lock]; rs.lock != "" && held {
			continue
		}
		if best == nil || rs.run.CreatedAt.Before(best.run.CreatedAt) ||
			(rs.run.CreatedAt.Equal(best.run.CreatedAt) && rs.seq < best.seq) {
			best = rs
		}
	}
	return best
}

func (s *Scheduler) startSetup(rs *runState) {
	id := rs.run.ID
	if err := s.st.Transition(context.Background(), id, []store.RunState{store.RunQueued}, store.RunRunning, ""); err != nil {
		err = fmt.Errorf("scheduler: start run %s: %w", id, err)
		s.log.Error("scheduler: store write failed", "run", id, "err", err)
		s.forget(rs, "", err)
		return
	}
	s.queue = slices.DeleteFunc(s.queue, func(r *runState) bool { return r == rs })
	s.active = append(s.active, rs)
	rs.started = true
	rs.run.State = store.RunRunning
	if rs.lock != "" {
		s.envLocks[rs.lock] = id
	}
	s.free--
	s.inflight++
	rs.running++
	run := rs.run
	go func() {
		err := s.runner.RunSetup(rs.ctx, run)
		s.results <- result{rs: rs, kind: workSetup, err: err}
	}()
}

func (s *Scheduler) startJob(rs *runState, name string) {
	id := rs.run.ID
	if err := s.st.TransitionJob(context.Background(), id, name, []store.JobState{store.JobQueued}, store.JobRunning, store.JobUpdate{}); err != nil {
		s.writeFailed(rs, name, err)
		s.stop(rs, store.RunFailed, "scheduler: "+err.Error(), store.JobSkipped)
		return
	}
	rs.graph.MarkRunning(name)
	s.free--
	s.inflight++
	rs.running++
	run := rs.run
	job := rs.jobs[name]
	job.State = store.JobRunning
	start := s.clock.Now()
	go func() {
		out, err := s.runner.RunJob(rs.ctx, run, job)
		dur := s.clock.Now().Sub(start).Milliseconds()
		s.results <- result{rs: rs, kind: workJob, job: name, dur: dur, out: out, err: err}
	}()
}

// apply records a finished unit of work.
func (s *Scheduler) apply(r result) {
	s.inflight--
	rs := r.rs
	switch r.kind {
	case workFinish:
		s.settleRun(rs)
		close(rs.done)
		delete(s.runs, rs.run.ID)
		s.notifyIdle()
		return
	case workSetup:
		s.free++
		rs.running--
		switch {
		case r.err != nil && rs.stopState == "":
			s.stop(rs, store.RunFailed, "setup failed: "+r.err.Error(), store.JobSkipped)
		case r.err == nil:
			rs.setupDone = true
		}
	case workJob:
		s.free++
		rs.running--
		s.settleJob(rs, r)
	}
	s.maybeFinish(rs)
}

func (s *Scheduler) settleJob(rs *runState, r result) {
	st, reason, exit := r.out.State, r.out.Reason, r.out.ExitCode
	switch {
	case r.err != nil && st != store.JobCancelled:
		st, reason = store.JobFailed, r.err.Error()
	case st != store.JobSuccess && st != store.JobFailed && st != store.JobCancelled:
		st, reason = store.JobFailed, fmt.Sprintf("runner returned job state %q", r.out.State)
	}
	skipReason := "needs " + r.job + " failed"
	if rs.stopState != "" {
		skipReason = rs.stopReason
		if st != store.JobSuccess {
			// The job ended because the run was stopped.
			st, reason = store.JobCancelled, rs.stopReason
			if rs.stopState == store.RunInterrupted {
				st = store.JobInterrupted
			}
		}
	}

	upd := store.JobUpdate{Reason: reason, DurationMS: &r.dur, Tail: r.out.Tail, LogsLocal: r.out.LogsLocal}
	if st == store.JobSuccess || st == store.JobFailed {
		upd.ExitCode = &exit
	}
	if err := s.st.TransitionJob(context.Background(), rs.run.ID, r.job, []store.JobState{store.JobRunning}, st, upd); err != nil {
		s.writeFailed(rs, r.job, err)
	}
	if (st == store.JobFailed || st == store.JobCancelled) && rs.failedJob == "" {
		rs.failedJob = r.job
	}
	for _, d := range rs.graph.MarkDone(r.job, st) {
		if err := s.st.TransitionJob(context.Background(), rs.run.ID, d, []store.JobState{store.JobQueued}, store.JobSkipped, store.JobUpdate{Reason: skipReason}); err != nil {
			s.writeFailed(rs, d, err)
		}
	}
}

// stop makes a started run end early with state and reason once its in-flight
// work returns. Queued jobs become jobs.
func (s *Scheduler) stop(rs *runState, state store.RunState, reason string, jobs store.JobState) {
	if rs.stopState != "" || rs.finishing {
		return
	}
	rs.stopState, rs.stopReason, rs.stopJobs = state, reason, jobs
	rs.cancel()
	s.maybeFinish(rs)
}

func (s *Scheduler) maybeFinish(rs *runState) {
	if !rs.started || rs.finishing || rs.running > 0 {
		return
	}
	if rs.stopState == "" && !(rs.setupDone && rs.graph.Done()) {
		return
	}
	s.finish(rs)
}

// finish settles the run's abandoned jobs and calls FinishRun in the
// background. The run stays running in the store until teardown returns, so
// a crash during teardown leaves it for recovery to sweep; settleRun then
// moves it to its terminal state.
func (s *Scheduler) finish(rs *runState) {
	rs.finishing = true
	id := rs.run.ID
	final, reason := rs.stopState, rs.stopReason
	if final == "" {
		final = rs.graph.Final()
		if final == store.RunFailed {
			reason = "job " + rs.failedJob + " failed"
		}
	} else {
		for _, name := range rs.graph.Abandon(rs.stopJobs) {
			if err := s.st.TransitionJob(context.Background(), id, name, []store.JobState{store.JobQueued}, rs.stopJobs, store.JobUpdate{Reason: reason}); err != nil {
				s.writeFailed(rs, name, err)
			}
		}
	}
	rs.run.State, rs.run.Reason = final, reason
	s.active = slices.DeleteFunc(s.active, func(r *runState) bool { return r == rs })
	rs.cancel()

	s.inflight++
	run := rs.run
	go func() {
		if err := s.runner.FinishRun(context.WithoutCancel(rs.ctx), run, final); err != nil {
			s.log.Warn("scheduler: finish run failed", "run", run.ID, "err", err)
		}
		s.results <- result{rs: rs, kind: workFinish}
	}()
}

// settleRun moves a torn-down run to the terminal state finish chose and
// releases its env lock.
func (s *Scheduler) settleRun(rs *runState) {
	id := rs.run.ID
	if err := s.st.Transition(context.Background(), id, []store.RunState{store.RunRunning}, rs.run.State, rs.run.Reason); err != nil {
		s.writeFailed(rs, "", err)
	}
	rs.final = rs.run.State
	if rs.lock != "" && s.envLocks[rs.lock] == id {
		delete(s.envLocks, rs.lock)
	}
}

// forget drops a run that never started and wakes its waiters.
func (s *Scheduler) forget(rs *runState, final store.RunState, err error) {
	s.queue = slices.DeleteFunc(s.queue, func(r *runState) bool { return r == rs })
	rs.final, rs.err = final, err
	rs.cancel()
	close(rs.done)
	delete(s.runs, rs.run.ID)
	s.notifyIdle()
}

func (s *Scheduler) writeFailed(rs *runState, job string, err error) {
	s.log.Error("scheduler: store write failed", "run", rs.run.ID, "job", job, "err", err)
	if rs.err == nil {
		rs.err = fmt.Errorf("scheduler: run %s: %w", rs.run.ID, err)
	}
}

func (s *Scheduler) notifyIdle() {
	if len(s.runs) == 0 && s.idle != nil {
		close(s.idle)
		s.idle = nil
	}
}
