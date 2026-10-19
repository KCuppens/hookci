package scheduler

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// waitTimeout bounds every wait so a scheduler bug fails the test instead of
// hanging it. Nothing sleeps; waits return as soon as the state changes.
const waitTimeout = 10 * time.Second

var errFake = errors.New("fake failure")

// fakeClock returns a time that moves one second forward on every read, so
// runs created one after another get strictly increasing CreatedAt values.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := c.now
	c.now = c.now.Add(time.Second)
	return t
}

// fakeRunner implements JobRunner. Work items are named "<run>:setup" and
// "<run>:<job>". By default every item blocks until the test releases it; in
// auto mode items finish at once unless they are held. A blocked item returns
// early when its ctx is cancelled: setup with ctx.Err(), a job as cancelled.
type fakeRunner struct {
	mu       sync.Mutex
	changed  chan struct{} // closed and replaced on every state change
	auto     bool
	hold     map[string]bool
	fail     map[string]bool
	gates    map[string]chan error
	starts   []string
	pending  []string // started, blocked and not yet released
	running  int
	max      int
	finishes map[string][]store.RunState
	onSetup  func(run store.Run)
}

func newFakeRunner() *fakeRunner {
	return &fakeRunner{
		changed:  make(chan struct{}),
		hold:     map[string]bool{},
		fail:     map[string]bool{},
		gates:    map[string]chan error{},
		finishes: map[string][]store.RunState{},
	}
}

func (r *fakeRunner) RunSetup(ctx context.Context, run store.Run) error {
	r.mu.Lock()
	hook := r.onSetup
	r.mu.Unlock()
	if hook != nil {
		hook(run)
	}
	return r.do(ctx, run.ID+":setup")
}

func (r *fakeRunner) RunJob(ctx context.Context, run store.Run, job store.Job) (JobOutcome, error) {
	err := r.do(ctx, run.ID+":"+job.Name)
	switch {
	case ctx.Err() != nil && err != nil:
		return JobOutcome{State: store.JobCancelled, Reason: "cancelled"}, nil
	case err != nil:
		return JobOutcome{State: store.JobFailed, ExitCode: 1, Reason: "exit 1"}, nil
	default:
		return JobOutcome{State: store.JobSuccess}, nil
	}
}

func (r *fakeRunner) FinishRun(_ context.Context, run store.Run, final store.RunState) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.finishes[run.ID] = append(r.finishes[run.ID], final)
	r.notify()
	return nil
}

func (r *fakeRunner) do(ctx context.Context, item string) error {
	r.mu.Lock()
	r.starts = append(r.starts, item)
	r.running++
	r.max = max(r.max, r.running)
	block := !r.auto || r.hold[item]
	var gate chan error
	if block {
		gate = make(chan error, 1)
		r.gates[item] = gate
		r.pending = append(r.pending, item)
	}
	failed := r.fail[item]
	r.notify()
	r.mu.Unlock()

	var err error
	if block {
		select {
		case err = <-gate:
		case <-ctx.Done():
			err = ctx.Err()
		}
	} else if failed {
		err = errFake
	}

	r.mu.Lock()
	r.running--
	r.pending = slices.DeleteFunc(r.pending, func(p string) bool { return p == item })
	delete(r.gates, item)
	r.notify()
	r.mu.Unlock()
	return err
}

// notify wakes waiters; r.mu must be held.
func (r *fakeRunner) notify() {
	close(r.changed)
	r.changed = make(chan struct{})
}

// waitFor blocks until pred, evaluated under r.mu, holds.
func (r *fakeRunner) waitFor(t *testing.T, what string, pred func() bool) {
	t.Helper()
	deadline := time.NewTimer(waitTimeout)
	defer deadline.Stop()
	for {
		r.mu.Lock()
		ok := pred()
		ch := r.changed
		r.mu.Unlock()
		if ok {
			return
		}
		select {
		case <-ch:
		case <-deadline.C:
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// waitStarted blocks until item is pending (started and blocked).
func (r *fakeRunner) waitStarted(t *testing.T, item string) {
	t.Helper()
	r.waitFor(t, item+" to start", func() bool { return slices.Contains(r.pending, item) })
}

// next blocks until some item is pending and returns the oldest.
func (r *fakeRunner) next(t *testing.T) string {
	t.Helper()
	var item string
	r.waitFor(t, "a pending item", func() bool {
		if len(r.pending) == 0 {
			return false
		}
		item = r.pending[0]
		return true
	})
	return item
}

// finish ends a pending item with err (nil means success).
func (r *fakeRunner) finish(t *testing.T, item string, err error) {
	t.Helper()
	r.waitStarted(t, item)
	r.mu.Lock()
	gate := r.gates[item]
	r.pending = slices.DeleteFunc(r.pending, func(p string) bool { return p == item })
	r.mu.Unlock()
	gate <- err
}

func (r *fakeRunner) release(t *testing.T, item string) {
	t.Helper()
	r.finish(t, item, nil)
}

// releaseN releases the oldest pending item n times.
func (r *fakeRunner) releaseN(t *testing.T, n int) {
	t.Helper()
	for range n {
		r.release(t, r.next(t))
	}
}

func (r *fakeRunner) Starts() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.starts)
}

func (r *fakeRunner) MaxConcurrent() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.max
}

func (r *fakeRunner) Finishes(runID string) []store.RunState {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.finishes[runID])
}

func (r *fakeRunner) setAuto(hold ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.auto = true
	for _, h := range hold {
		r.hold[h] = true
	}
}

func (r *fakeRunner) setFail(items ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, it := range items {
		r.fail[it] = true
	}
}

// harness wires a scheduler to a fresh store, a fake clock and a fake runner.
type harness struct {
	t      *testing.T
	ctx    context.Context
	db     *store.Store
	runner *fakeRunner
	s      *Scheduler
}

func newHarness(t *testing.T, slots int) *harness {
	t.Helper()
	clock := newFakeClock()
	db, err := store.Open(filepath.Join(t.TempDir(), "agent.db"), store.WithClock(clock.Now))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	r := newFakeRunner()
	s := New(db, r, Options{Slots: slots, Clock: clock, Logger: slog.New(slog.DiscardHandler)})
	t.Cleanup(func() { _ = s.Close() })
	return &harness{t: t, ctx: context.Background(), db: db, runner: r, s: s}
}

func job(name string, needs ...string) store.Job {
	return store.Job{Name: name, Needs: needs}
}

// indep returns n independent jobs j0..j<n-1>.
func indep(n int) []store.Job {
	jobs := make([]store.Job, n)
	for i := range jobs {
		jobs[i] = job("j" + strconv.Itoa(i))
	}
	return jobs
}

func pushRun(id, sha, ref string) store.Run {
	return store.Run{ID: id, Repo: "o/r", SHA: sha, Ref: ref, Event: "push", Kind: "check", TrustDomain: "trusted:o/r"}
}

func prRun(id, sha string, pr int) store.Run {
	return store.Run{ID: id, Repo: "o/r", SHA: sha, Ref: "refs/pull/" + strconv.Itoa(pr) + "/head", Event: "pull_request", PR: &pr, Kind: "check", TrustDomain: "trusted:o/r"}
}

func deployRun(id, sha, env string) store.Run {
	return store.Run{ID: id, Repo: "o/r", SHA: sha, Ref: "main", Event: "push", Kind: "deploy", Env: env, TrustDomain: "trusted:o/r"}
}

func (h *harness) create(run store.Run, jobs ...store.Job) string {
	h.t.Helper()
	if err := h.db.CreateRun(h.ctx, run, jobs); err != nil {
		h.t.Fatalf("CreateRun %s: %v", run.ID, err)
	}
	return run.ID
}

func (h *harness) submit(id string) []string {
	h.t.Helper()
	superseded, err := h.s.Submit(h.ctx, id)
	if err != nil {
		h.t.Fatalf("Submit %s: %v", id, err)
	}
	return superseded
}

func (h *harness) wait(id string) store.RunState {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(h.ctx, waitTimeout)
	defer cancel()
	st, err := h.s.Wait(ctx, id)
	if err != nil {
		h.t.Fatalf("Wait %s: %v", id, err)
	}
	return st
}

func (h *harness) idle() {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(h.ctx, waitTimeout)
	defer cancel()
	if err := h.s.Idle(ctx); err != nil {
		h.t.Fatalf("Idle: %v", err)
	}
}

func (h *harness) run(id string) store.Run {
	h.t.Helper()
	run, err := h.db.GetRun(h.ctx, id)
	if err != nil {
		h.t.Fatalf("GetRun %s: %v", id, err)
	}
	return run
}

func (h *harness) jobs(id string) map[string]store.Job {
	h.t.Helper()
	jobs, err := h.db.Jobs(h.ctx, id)
	if err != nil {
		h.t.Fatalf("Jobs %s: %v", id, err)
	}
	out := make(map[string]store.Job, len(jobs))
	for _, j := range jobs {
		out[j.Name] = j
	}
	return out
}

// wantRun checks the stored state and reason of a run.
func (h *harness) wantRun(id string, state store.RunState, reason string) {
	h.t.Helper()
	run := h.run(id)
	if run.State != state || run.Reason != reason {
		h.t.Errorf("run %s = %s %q, want %s %q", id, run.State, run.Reason, state, reason)
	}
}

// wantJob checks the stored state and reason of a job.
func (h *harness) wantJob(id, name string, state store.JobState, reason string) {
	h.t.Helper()
	j := h.jobs(id)[name]
	if j.State != state || j.Reason != reason {
		h.t.Errorf("job %s/%s = %s %q, want %s %q", id, name, j.State, j.Reason, state, reason)
	}
}
