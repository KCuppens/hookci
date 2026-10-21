package deploy

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// Scheduler defaults.
const (
	DefaultNeedsTimeout = time.Hour
	DefaultPollInterval = 5 * time.Second
)

// queued is a run waiting in the Scheduler. Retry starts it with
// Engine.Retry instead of Engine.Start.
type queued struct {
	RunID string
	Retry bool
}

// Scheduler starts queued deploy runs on the deploy lane, which is separate
// from the CI slot pool. Per (repo, env) it runs one run at a time under the
// store's env lock, supersedes every queued run but the newest, and holds a
// run until each environment it needs has deployed the same commit.
type Scheduler struct {
	Store  *store.Store
	Engine *Engine
	Events EventSink
	Clock  func() time.Time // nil means time.Now
	Logger *slog.Logger     // nil means slog.Default()
	// NeedsTimeout is how long a run waits for the environments it needs;
	// 0 means DefaultNeedsTimeout.
	NeedsTimeout time.Duration
	// PollInterval is how often Run ticks without a wake-up, which rechecks
	// runs waiting on needs; 0 means DefaultPollInterval.
	PollInterval time.Duration
	// LoadDeployment returns the deployments.<env> block of the trusted
	// config at run.SHA. It is called once per queued run.
	LoadDeployment func(ctx context.Context, run store.DeployRun) (config.Deployment, error)
	// PostRun, when set, runs after a deploy ends Success or Failed and its
	// env lock is released, on the deploy goroutine. Its failures and panics
	// never change the run.
	PostRun func(ctx context.Context, run store.DeployRun)

	tickMu sync.Mutex
	needs  map[string][]string // run ID -> needs of a queued run; guarded by tickMu

	mu     sync.Mutex
	q      []queued
	active map[string]bool // run IDs started and not yet finished
	wake   chan struct{}
	wg     sync.WaitGroup
}

// pending is a queue entry with its stored run.
type pending struct {
	entry queued
	run   store.DeployRun
}

type envKey struct{ repo, env string }

// Enqueue adds runID to the queue and wakes Run. A run already queued or
// running is not added again.
func (s *Scheduler) Enqueue(_ context.Context, runID string, retry bool) {
	s.mu.Lock()
	s.initLocked()
	if s.active[runID] || slices.ContainsFunc(s.q, func(e queued) bool { return e.RunID == runID }) {
		s.mu.Unlock()
		return
	}
	s.q = append(s.q, queued{RunID: runID, Retry: retry})
	s.mu.Unlock()
	s.signal()
}

// Recover enqueues the stored Queued runs, oldest first. A run whose
// trigger was never answered as accepted, because the agent stopped between
// creating the run and recording the answer, stays Queued: the hub
// redelivers that trigger, and the intake then links it to the run and
// enqueues it. A run re-queued by a retry is enqueued as a retry.
func (s *Scheduler) Recover(ctx context.Context) error {
	runs, err := s.Store.ListQueuedDeployRuns(ctx)
	if err != nil {
		return fmt.Errorf("deploy: recover queue: %w", err)
	}
	for _, r := range runs {
		accepted, err := s.Store.DeployRunAccepted(ctx, r.RunID)
		if err != nil {
			return fmt.Errorf("deploy: recover queue: %w", err)
		}
		if !accepted {
			s.logger().Warn("deploy run has no accepted trigger; waiting for the hub to redeliver it", "run", r.RunID)
			continue
		}
		s.Enqueue(ctx, r.RunID, r.RetryOfState != "")
	}
	return nil
}

// Run ticks on every wake-up and every PollInterval until ctx ends. Started
// deploys run on with ctx; Wait waits for them.
func (s *Scheduler) Run(ctx context.Context) {
	s.mu.Lock()
	s.initLocked()
	wake := s.wake
	s.mu.Unlock()
	interval := s.PollInterval
	if interval <= 0 {
		interval = DefaultPollInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if _, err := s.Tick(ctx); err != nil && ctx.Err() == nil {
			s.logger().Error("deploy scheduler tick failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-wake:
		case <-ticker.C:
		}
	}
}

// Wait blocks until every started deploy has returned and released its lock.
func (s *Scheduler) Wait() {
	s.wg.Wait()
}

// Tick applies the queue rules once, in order: interruption, supersede,
// needs, env lock, start. It returns how many runs it started. A run whose
// rules could not be checked stays queued and its error is returned.
//
// An Interrupted run left its env in an unknown state: a retry of it goes
// first and is never superseded, the env's other runs wait for it, and while
// no retry is queued the env's other runs fail until `hookci retry` finishes
// the interrupted one.
func (s *Scheduler) Tick(ctx context.Context) (started int, err error) {
	s.tickMu.Lock()
	defer s.tickMu.Unlock()
	if s.needs == nil {
		s.needs = map[string][]string{}
	}
	s.mu.Lock()
	entries := slices.Clone(s.q)
	s.mu.Unlock()

	var errs []error
	leave := map[string]bool{} // entries that leave the queue
	groups := map[envKey][]pending{}
	var order []envKey
	for _, e := range entries {
		run, err := s.Store.GetDeployRun(ctx, e.RunID)
		if errors.Is(err, store.ErrNotFound) || err == nil && run.State != store.DeployQueued && run.State != store.DeployInterrupted {
			leave[e.RunID] = true
			continue
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("deploy: %w", err))
			continue
		}
		k := envKey{run.Repo, run.Env}
		if _, ok := groups[k]; !ok {
			order = append(order, k)
		}
		groups[k] = append(groups[k], pending{entry: e, run: run})
	}

	interrupted, err := s.unresolvedInterruptions(ctx, order)
	if err != nil {
		return 0, err
	}
	for _, k := range order {
		group := groups[k]
		if i := slices.IndexFunc(group, resolvesInterruption); i >= 0 {
			ok, err := s.admit(ctx, group[i], leave)
			if err != nil {
				errs = append(errs, err)
			}
			if ok {
				started++
			}
			continue
		}
		if blocker, ok := interrupted[k]; ok {
			msg := fmt.Sprintf("deployments.%s: run %s was interrupted and left the environment in an unknown state; finish it with hookci retry %s before deploying again",
				k.env, blocker.RunID, blocker.RunID)
			for _, p := range group {
				if err := s.finish(ctx, p.run.RunID, store.DeployFailed, protocol.EventStateFailed, msg); err != nil {
					errs = append(errs, err)
					continue
				}
				leave[p.run.RunID] = true
			}
			continue
		}
		newest := group[0]
		for _, p := range group[1:] {
			if !p.run.CreatedAt.Before(newest.run.CreatedAt) {
				newest = p
			}
		}
		for _, p := range group {
			if p.run.RunID == newest.run.RunID {
				continue
			}
			if err := s.finish(ctx, p.run.RunID, store.DeploySuperseded, protocol.EventStateSuperseded,
				"superseded by "+newest.run.RunID); err != nil {
				errs = append(errs, err)
				continue
			}
			leave[p.run.RunID] = true
		}

		ok, err := s.admit(ctx, newest, leave)
		if err != nil {
			errs = append(errs, err)
		}
		if ok {
			started++
		}
	}

	s.mu.Lock()
	s.q = slices.DeleteFunc(s.q, func(e queued) bool { return leave[e.RunID] })
	s.mu.Unlock()
	for id := range leave {
		delete(s.needs, id)
	}
	return started, errors.Join(errs...)
}

// resolvesInterruption reports whether p takes up an Interrupted run: the
// run itself or a queued retry of it.
func resolvesInterruption(p pending) bool {
	return p.run.State == store.DeployInterrupted || p.run.RetryOfState == store.DeployInterrupted
}

// unresolvedInterruptions returns, per env of keys, the oldest Interrupted
// run no Success run of that env finished after.
func (s *Scheduler) unresolvedInterruptions(ctx context.Context, keys []envKey) (map[envKey]store.DeployRun, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	runs, err := s.Store.ListDeployRunsInStates(ctx, store.DeployInterrupted)
	if err != nil {
		return nil, fmt.Errorf("deploy: %w", err)
	}
	out := map[envKey]store.DeployRun{}
	lastSuccess := map[envKey]time.Time{}
	for _, r := range runs {
		k := envKey{r.Repo, r.Env}
		if _, done := out[k]; done || !slices.Contains(keys, k) {
			continue
		}
		last, ok := lastSuccess[k]
		if !ok {
			succ, err := s.Store.LastSucceededRuns(ctx, r.Repo, r.Env, 1)
			if err != nil {
				return nil, fmt.Errorf("deploy: %w", err)
			}
			if len(succ) > 0 {
				last = succ[0].FinishedAt
			}
			lastSuccess[k] = last
		}
		if !last.After(r.FinishedAt) {
			out[k] = r
		}
	}
	return out, nil
}

// admit checks the needs of p, takes its env lock and starts it. It reports
// whether p started and marks p in leave when it left the queue.
func (s *Scheduler) admit(ctx context.Context, p pending, leave map[string]bool) (bool, error) {
	run := p.run
	wait, msg, err := s.checkNeeds(ctx, run)
	if err != nil {
		return false, err
	}
	if msg != "" {
		if err := s.finish(ctx, run.RunID, store.DeployFailed, protocol.EventStateFailed, msg); err != nil {
			return false, err
		}
		leave[run.RunID] = true
		return false, nil
	}
	if wait {
		return false, nil
	}
	ok, err := s.Store.TryAcquireEnvLock(ctx, run.Repo, run.Env, run.RunID, s.now())
	if err != nil {
		return false, fmt.Errorf("deploy: %w", err)
	}
	if !ok {
		return false, nil
	}
	leave[run.RunID] = true
	s.mu.Lock()
	s.active[run.RunID] = true
	s.mu.Unlock()
	s.wg.Add(1)
	go s.deploy(ctx, p)
	return true, nil
}

// checkNeeds reports wait while an environment run needs has not deployed
// run.SHA yet, or msg, the reason run fails, once one never will.
func (s *Scheduler) checkNeeds(ctx context.Context, run store.DeployRun) (wait bool, msg string, err error) {
	needs, ok := s.needs[run.RunID]
	if !ok {
		dep, err := s.LoadDeployment(ctx, run)
		if err != nil {
			if ctx.Err() != nil {
				return false, "", fmt.Errorf("deploy: run %s: load config: %w", run.RunID, err)
			}
			return false, fmt.Sprintf("deployments.%s: load config: %v", run.Env, err), nil
		}
		needs = dep.Needs
		s.needs[run.RunID] = needs
	}
	timeout := s.NeedsTimeout
	if timeout <= 0 {
		timeout = DefaultNeedsTimeout
	}
	for _, other := range needs {
		state := ""
		switch dep, err := s.Store.LatestDeployRunFor(ctx, run.Repo, other, run.SHA); {
		case err == nil:
			state = dep.State
		case !errors.Is(err, store.ErrNotFound):
			return false, "", fmt.Errorf("deploy: %w", err)
		}
		switch state {
		case store.DeploySuccess:
			continue
		case store.DeployFailed, store.DeploySuperseded, store.DeployInterrupted:
			return false, fmt.Sprintf("deployments.%s.needs: %s failed for %s", run.Env, other, shortSHA(run.SHA)), nil
		}
		if s.now().Sub(run.QueuedAt) > timeout {
			return false, fmt.Sprintf("deployments.%s.needs: no successful %s deploy of %s within %s; bind %s to this agent or remove needs",
				run.Env, other, shortSHA(run.SHA), shortDuration(timeout), other), nil
		}
		wait = true
	}
	return wait, "", nil
}

// deploy runs p on the deploy lane while holding its env lock.
func (s *Scheduler) deploy(ctx context.Context, p pending) {
	defer s.wg.Done()
	defer s.postRun(ctx, p.run.RunID)
	defer s.release(ctx, p.run)
	var err error
	if p.entry.Retry {
		err = s.Engine.Retry(ctx, p.run.RunID)
	} else {
		err = s.Engine.Start(ctx, p.run.RunID)
	}
	if err == nil {
		return
	}
	s.logger().Error("deploy run stopped before it finished", "run_id", p.run.RunID, "err", err)
	if ctx.Err() == nil {
		s.failStopped(context.WithoutCancel(ctx), p.run, err)
	}
}

// failStopped fails run when the engine returned err with the run still
// Running, Verifying or RollingBack, for example after a store error while
// recording a step: nothing else would end it before the next restart. A run
// the engine never started stays as it is.
func (s *Scheduler) failStopped(ctx context.Context, run store.DeployRun, err error) {
	cur, getErr := s.Store.GetDeployRun(ctx, run.RunID)
	if getErr != nil {
		s.logger().Error("load stopped deploy run", "run_id", run.RunID, "err", getErr)
		return
	}
	switch cur.State {
	case store.DeployRunning, store.DeployVerifying, store.DeployRollingBack:
	default:
		return
	}
	msg := fmt.Sprintf("deployments.%s: deploy stopped: %v", run.Env, err)
	if err := s.finish(ctx, run.RunID, store.DeployFailed, protocol.EventStateFailed, msg); err != nil {
		s.logger().Error("record stopped deploy run", "run_id", run.RunID, "err", err)
	}
}

// release ends a deploy goroutine: it fails the run when the deploy
// panicked, releases the env lock and wakes Run.
func (s *Scheduler) release(ctx context.Context, run store.DeployRun) {
	ctx = context.WithoutCancel(ctx)
	if v := recover(); v != nil {
		msg := fmt.Sprintf("deployments.%s: deploy crashed: %v", run.Env, v)
		s.logger().Error("deploy run panicked", "run_id", run.RunID, "panic", v, "stack", string(debug.Stack()))
		if err := s.finish(ctx, run.RunID, store.DeployFailed, protocol.EventStateFailed, msg); err != nil {
			s.logger().Error("record deploy panic", "run_id", run.RunID, "err", err)
		}
	}
	if err := s.Store.ReleaseEnvLock(ctx, run.Repo, run.Env, run.RunID); err != nil {
		s.logger().Error("release env lock", "run_id", run.RunID, "err", err)
	}
	s.mu.Lock()
	delete(s.active, run.RunID)
	s.mu.Unlock()
	s.signal()
}

// postRun calls PostRun when runID ended Success or Failed.
func (s *Scheduler) postRun(ctx context.Context, runID string) {
	if s.PostRun == nil || ctx.Err() != nil {
		return
	}
	defer func() {
		if v := recover(); v != nil {
			s.logger().Error("deploy post-run hook panicked", "run_id", runID, "panic", v, "stack", string(debug.Stack()))
		}
	}()
	run, err := s.Store.GetDeployRun(ctx, runID)
	if err != nil {
		s.logger().Warn("deploy post-run hook skipped", "run_id", runID, "err", err)
		return
	}
	if run.State == store.DeploySuccess || run.State == store.DeployFailed {
		s.PostRun(ctx, run)
	}
}

// finish moves runID to the final state with error msg and emits its event.
func (s *Scheduler) finish(ctx context.Context, runID, state string, evState protocol.EventState, msg string) error {
	if err := s.Store.SetDeployRunState(ctx, runID, state, msg, s.now()); err != nil {
		return fmt.Errorf("deploy: %w", err)
	}
	job := JobName
	sendStateChange(s.Events, protocol.Event{RunId: runID, Job: &job, State: evState, Reason: &msg})
	return nil
}

// signal wakes Run without blocking.
func (s *Scheduler) signal() {
	s.mu.Lock()
	s.initLocked()
	wake := s.wake
	s.mu.Unlock()
	select {
	case wake <- struct{}{}:
	default:
	}
}

func (s *Scheduler) initLocked() {
	if s.wake == nil {
		s.wake = make(chan struct{}, 1)
		s.active = map[string]bool{}
	}
}

func (s *Scheduler) now() time.Time {
	if s.Clock == nil {
		return time.Now()
	}
	return s.Clock()
}

func (s *Scheduler) logger() *slog.Logger {
	if s.Logger == nil {
		return slog.Default()
	}
	return s.Logger
}

// shortSHA is the 7-character abbreviation of sha.
func shortSHA(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// shortDuration is d without trailing zero units: 1h, 1h30m, 45m.
func shortDuration(d time.Duration) string {
	s := d.String()
	if strings.HasSuffix(s, "m0s") {
		s = strings.TrimSuffix(s, "0s")
	}
	if strings.HasSuffix(s, "h0m") {
		s = strings.TrimSuffix(s, "0m")
	}
	return s
}
