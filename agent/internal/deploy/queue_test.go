package deploy

import (
	"context"
	"errors"
	"log/slog"
	"maps"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/scheduler"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// testSHA abbreviates to abc1234 in needs errors.
const testSHA = "abc1234def5678"

// queueRig is a Scheduler over a real store and Engine whose fake strategy
// runs one step per deploy. The step reports its run ID on starts, then
// blocks until the test hands it a result with step.
type queueRig struct {
	sched  *Scheduler
	store  *store.Store
	strat  *fakeStrategy
	events *fakeEvents
	clock  *clock.Fake
	needs  map[string][]string // env -> deployments.<env>.needs
	starts chan string

	mu    sync.Mutex
	gates map[string]chan func() error
}

func newQueueRig(t *testing.T, dbPath string, steps []fakeStep) *queueRig {
	t.Helper()
	clk := clock.NewFake(t0)
	st, err := store.Open(dbPath, store.WithClock(clk.Now))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	r := &queueRig{
		store: st, events: &fakeEvents{}, clock: clk, needs: map[string][]string{},
		starts: make(chan string, 16), gates: map[string]chan func() error{},
	}
	r.strat = &fakeStrategy{clock: clk, steps: steps, hook: func(ctx context.Context, sc *StepContext, _ int) error {
		r.starts <- sc.Run.RunID
		select {
		case fn := <-r.gate(sc.Run.RunID):
			return fn()
		case <-ctx.Done():
			return ctx.Err()
		}
	}}
	load := func(_ context.Context, run store.DeployRun) (config.Deployment, error) {
		return config.Deployment{Strategy: "fake", Needs: r.needs[run.Env]}, nil
	}
	r.sched = &Scheduler{
		Store: st,
		Engine: &Engine{
			Store:      st,
			Strategies: map[string]DeployStrategy{r.strat.Name(): r.strat},
			Events:     r.events,
			Clock:      clk,
			NewExecutor: func(context.Context, store.DeployRun, config.Deployment) (Executor, error) {
				return &fakeExecutor{}, nil
			},
			Checkout:       func(context.Context, store.DeployRun) error { return nil },
			LoadDeployment: load,
		},
		Events:         r.events,
		Clock:          clk.Now,
		Logger:         slog.New(slog.DiscardHandler),
		LoadDeployment: load,
	}
	return r
}

func (r *queueRig) gate(runID string) chan func() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	g, ok := r.gates[runID]
	if !ok {
		g = make(chan func() error, 4)
		r.gates[runID] = g
	}
	return g
}

// step lets the next step of runID end with fn's result.
func (r *queueRig) step(runID string, fn func() error) { r.gate(runID) <- fn }

func succeed() error { return nil }

func (r *queueRig) insert(t *testing.T, runID, env string, created time.Time, state string) {
	t.Helper()
	if err := r.store.InsertDeployRun(context.Background(), store.DeployRun{
		RunID: runID, Repo: "acme/web", Env: env, SHA: testSHA, Ref: "refs/heads/main",
		Strategy: "fake", State: state, CreatedAt: created,
	}); err != nil {
		t.Fatalf("InsertDeployRun(%s): %v", runID, err)
	}
}

// tick runs one Tick and checks how many runs it started.
func (r *queueRig) tick(t *testing.T, ctx context.Context, want int) {
	t.Helper()
	got, err := r.sched.Tick(ctx)
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if got != want {
		t.Fatalf("Tick started %d runs, want %d", got, want)
	}
}

// awaitStart returns the run ID of the next deploy step that starts.
func (r *queueRig) awaitStart(t *testing.T) string {
	t.Helper()
	select {
	case id := <-r.starts:
		return id
	case <-time.After(10 * time.Second):
		t.Fatal("no deploy step started")
		return ""
	}
}

func (r *queueRig) get(t *testing.T, runID string) store.DeployRun {
	t.Helper()
	run, err := r.store.GetDeployRun(context.Background(), runID)
	if err != nil {
		t.Fatalf("GetDeployRun(%s): %v", runID, err)
	}
	return run
}

func (r *queueRig) wantState(t *testing.T, runID, want string) store.DeployRun {
	t.Helper()
	run := r.get(t, runID)
	if run.State != want {
		t.Errorf("run %s state = %s (%q), want %s", runID, run.State, run.Error, want)
	}
	return run
}

func (r *queueRig) lockHolder(t *testing.T, env string) string {
	t.Helper()
	holder, held, err := r.store.EnvLockHolder(context.Background(), "acme/web", env)
	if err != nil {
		t.Fatalf("EnvLockHolder: %v", err)
	}
	if !held {
		return ""
	}
	return holder
}

// eventsFor returns the events the rig saw for runID.
func (r *queueRig) eventsFor(runID string) []protocol.Event {
	r.events.mu.Lock()
	defer r.events.mu.Unlock()
	var out []protocol.Event
	for _, ev := range r.events.events {
		if ev.RunId == runID {
			out = append(out, ev)
		}
	}
	return out
}

var oneStep = []fakeStep{{"apply", PhaseApply}}

func newTestQueue(t *testing.T) *queueRig {
	t.Helper()
	return newQueueRig(t, filepath.Join(t.TempDir(), "agent.db"), oneStep)
}

func TestScheduler_OneRunPerEnv(t *testing.T) {
	ctx := context.Background()
	r := newTestQueue(t)
	r.insert(t, "a", "production", t0, store.DeployQueued)
	r.sched.Enqueue(ctx, "a", false)
	r.tick(t, ctx, 1)
	r.awaitStart(t)

	r.insert(t, "b", "production", t0.Add(time.Second), store.DeployQueued)
	r.sched.Enqueue(ctx, "b", false)
	r.tick(t, ctx, 0)
	r.wantState(t, "b", store.DeployQueued)
	if got := r.lockHolder(t, "production"); got != "a" {
		t.Errorf("production lock holder = %q, want a", got)
	}

	r.step("a", succeed)
	r.sched.Wait()
	r.wantState(t, "a", store.DeploySuccess)
	r.tick(t, ctx, 1)
	if got := r.awaitStart(t); got != "b" {
		t.Errorf("started %s, want b", got)
	}
	r.step("b", succeed)
	r.sched.Wait()
	r.wantState(t, "b", store.DeploySuccess)
}

func TestScheduler_DifferentEnvsRunConcurrently(t *testing.T) {
	ctx := context.Background()
	r := newTestQueue(t)
	r.insert(t, "p", "production", t0, store.DeployQueued)
	r.insert(t, "s", "staging", t0, store.DeployQueued)
	r.sched.Enqueue(ctx, "p", false)
	r.sched.Enqueue(ctx, "s", false)
	r.tick(t, ctx, 2)

	// Both steps are in flight at once: neither returns before the test
	// releases it.
	got := []string{r.awaitStart(t), r.awaitStart(t)}
	slices.Sort(got)
	if !slices.Equal(got, []string{"p", "s"}) {
		t.Fatalf("started %v, want [p s] together", got)
	}
	r.step("p", succeed)
	r.step("s", succeed)
	r.sched.Wait()
	r.wantState(t, "p", store.DeploySuccess)
	r.wantState(t, "s", store.DeploySuccess)
}

func TestScheduler_SupersedesOlderQueued(t *testing.T) {
	ctx := context.Background()
	r := newTestQueue(t)
	r.insert(t, "r0", "production", t0, store.DeployQueued)
	r.sched.Enqueue(ctx, "r0", false)
	r.tick(t, ctx, 1)
	r.awaitStart(t)

	for i, id := range []string{"q1", "q2", "q3"} {
		r.insert(t, id, "production", t0.Add(time.Duration(i+1)*time.Second), store.DeployQueued)
	}
	// Enqueue order differs from age: the newest by created_at wins.
	for _, id := range []string{"q3", "q1", "q2"} {
		r.sched.Enqueue(ctx, id, false)
	}
	r.tick(t, ctx, 0)
	for _, id := range []string{"q1", "q2"} {
		run := r.wantState(t, id, store.DeploySuperseded)
		if run.Error != "superseded by q3" {
			t.Errorf("run %s error = %q, want %q", id, run.Error, "superseded by q3")
		}
		evs := r.eventsFor(id)
		if len(evs) != 1 || evs[0].State != protocol.EventStateSuperseded || evs[0].Job == nil || *evs[0].Job != JobName {
			t.Errorf("run %s events = %+v, want one superseded event for job %s", id, evs, JobName)
		}
	}
	r.wantState(t, "q3", store.DeployQueued)

	r.step("r0", succeed)
	r.sched.Wait()
	r.tick(t, ctx, 1)
	if got := r.awaitStart(t); got != "q3" {
		t.Errorf("started %s, want q3", got)
	}
	r.step("q3", succeed)
	r.sched.Wait()
	r.wantState(t, "r0", store.DeploySuccess)
	r.wantState(t, "q3", store.DeploySuccess)
	if got := r.strat.ranIndexes(); len(got) != 2 {
		t.Errorf("steps ran %v, want one each for r0 and q3", got)
	}
}

func TestScheduler_NeverCancelsRunning(t *testing.T) {
	ctx := context.Background()
	r := newTestQueue(t)
	r.insert(t, "old", "production", t0, store.DeployQueued)
	r.sched.Enqueue(ctx, "old", false)
	r.tick(t, ctx, 1)
	r.awaitStart(t)

	r.insert(t, "new", "production", t0.Add(time.Minute), store.DeployQueued)
	r.sched.Enqueue(ctx, "new", false)
	r.tick(t, ctx, 0)
	r.wantState(t, "old", store.DeployRunning)
	for _, ev := range r.eventsFor("old") {
		if ev.State == protocol.EventStateSuperseded || ev.State == protocol.EventStateCancelled {
			t.Errorf("running run got event %s", ev.State)
		}
	}

	r.step("old", succeed)
	r.sched.Wait()
	r.wantState(t, "old", store.DeploySuccess)
	r.tick(t, ctx, 1)
	r.awaitStart(t)
	r.step("new", succeed)
	r.sched.Wait()
	r.wantState(t, "new", store.DeploySuccess)
}

func TestScheduler_NeedsWaitsForSuccess(t *testing.T) {
	ctx := context.Background()
	r := newTestQueue(t)
	r.needs["production"] = []string{"staging"}
	r.insert(t, "p", "production", t0, store.DeployQueued)
	r.sched.Enqueue(ctx, "p", false)
	r.tick(t, ctx, 0)
	r.wantState(t, "p", store.DeployQueued)

	r.insert(t, "s", "staging", t0, store.DeployQueued)
	r.sched.Enqueue(ctx, "s", false)
	r.tick(t, ctx, 1)
	if got := r.awaitStart(t); got != "s" {
		t.Fatalf("started %s, want s", got)
	}
	r.tick(t, ctx, 0)
	r.wantState(t, "p", store.DeployQueued)

	r.step("s", succeed)
	r.sched.Wait()
	r.wantState(t, "s", store.DeploySuccess)
	r.tick(t, ctx, 1)
	if got := r.awaitStart(t); got != "p" {
		t.Errorf("started %s, want p", got)
	}
	r.step("p", succeed)
	r.sched.Wait()
	r.wantState(t, "p", store.DeploySuccess)
}

func TestScheduler_NeedsFailsWhenNeededFailed(t *testing.T) {
	for _, state := range []string{store.DeployFailed, store.DeploySuperseded, store.DeployInterrupted} {
		t.Run(state, func(t *testing.T) {
			ctx := context.Background()
			r := newTestQueue(t)
			r.needs["production"] = []string{"staging"}
			r.insert(t, "s", "staging", t0, state)
			r.insert(t, "p", "production", t0, store.DeployQueued)
			r.sched.Enqueue(ctx, "p", false)
			r.tick(t, ctx, 0)

			const want = "deployments.production.needs: staging failed for abc1234"
			if run := r.wantState(t, "p", store.DeployFailed); run.Error != want {
				t.Errorf("error = %q, want %q", run.Error, want)
			}
			evs := r.eventsFor("p")
			if len(evs) != 1 || evs[0].State != protocol.EventStateFailed || evs[0].Reason == nil || *evs[0].Reason != want {
				t.Errorf("events = %+v, want one failed event with the reason", evs)
			}
			if got := r.lockHolder(t, "production"); got != "" {
				t.Errorf("production lock held by %q", got)
			}
		})
	}
}

func TestScheduler_NeedsTimeout(t *testing.T) {
	ctx := context.Background()
	r := newTestQueue(t)
	r.needs["production"] = []string{"staging"}
	r.insert(t, "p", "production", t0, store.DeployQueued)
	r.sched.Enqueue(ctx, "p", false)
	r.tick(t, ctx, 0)

	r.clock.Advance(time.Hour)
	r.tick(t, ctx, 0)
	r.wantState(t, "p", store.DeployQueued)

	r.clock.Advance(time.Second)
	r.tick(t, ctx, 0)
	const want = "deployments.production.needs: no successful staging deploy of abc1234 within 1h; bind staging to this agent or remove needs"
	if run := r.wantState(t, "p", store.DeployFailed); run.Error != want {
		t.Errorf("error = %q, want %q", run.Error, want)
	}
}

func TestScheduler_ReleasesLockOnError(t *testing.T) {
	tests := []struct {
		name      string
		end       func(r *queueRig, cancel context.CancelFunc)
		wantState string
	}{
		{"step fails", func(r *queueRig, _ context.CancelFunc) {
			r.step("a", func() error { return errors.New("boom") })
		}, store.DeployFailed},
		{"engine returns error", func(_ *queueRig, cancel context.CancelFunc) { cancel() }, store.DeployRunning},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r := newTestQueue(t)
			r.insert(t, "a", "production", t0, store.DeployQueued)
			r.sched.Enqueue(ctx, "a", false)
			r.tick(t, ctx, 1)
			r.awaitStart(t)
			if got := r.lockHolder(t, "production"); got != "a" {
				t.Fatalf("lock holder while running = %q, want a", got)
			}
			tc.end(r, cancel)
			r.sched.Wait()
			r.wantState(t, "a", tc.wantState)
			if got := r.lockHolder(t, "production"); got != "" {
				t.Errorf("lock still held by %q", got)
			}
		})
	}
}

func TestScheduler_ReleasesLockOnPanic(t *testing.T) {
	ctx := context.Background()
	r := newTestQueue(t)
	r.insert(t, "a", "production", t0, store.DeployQueued)
	r.sched.Enqueue(ctx, "a", false)
	r.tick(t, ctx, 1)
	r.awaitStart(t)
	r.step("a", func() error { panic("strategy bug") })
	r.sched.Wait()

	if got := r.lockHolder(t, "production"); got != "" {
		t.Errorf("lock still held by %q", got)
	}
	const want = "deployments.production: deploy crashed: strategy bug"
	if run := r.wantState(t, "a", store.DeployFailed); run.Error != want {
		t.Errorf("error = %q, want %q", run.Error, want)
	}

	r.insert(t, "b", "production", t0.Add(time.Second), store.DeployQueued)
	r.sched.Enqueue(ctx, "b", false)
	r.tick(t, ctx, 1)
	r.awaitStart(t)
	r.step("b", succeed)
	r.sched.Wait()
	r.wantState(t, "b", store.DeploySuccess)
}

func TestScheduler_RetryFlagCallsEngineRetry(t *testing.T) {
	tests := []struct {
		retry       bool
		wantAttempt int
		wantRan     []int
	}{
		{retry: true, wantAttempt: 2, wantRan: []int{1}},
		{retry: false, wantAttempt: 1, wantRan: []int{0, 1}},
	}
	for _, tc := range tests {
		t.Run(map[bool]string{true: "retry", false: "start"}[tc.retry], func(t *testing.T) {
			ctx := context.Background()
			r := newQueueRig(t, filepath.Join(t.TempDir(), "agent.db"), []fakeStep{{"build", PhaseApply}, {"start", PhaseApply}})
			r.insert(t, "a", "production", t0, store.DeployInterrupted)
			if err := r.store.BeginStep(ctx, "a", 0, "build", nil, t0); err != nil {
				t.Fatalf("BeginStep: %v", err)
			}
			if err := r.store.FinishStep(ctx, "a", 0, store.StepDone, map[string]string{"build": "out0"}, t0); err != nil {
				t.Fatalf("FinishStep: %v", err)
			}
			if tc.retry {
				if _, err := PrepareRetry(ctx, r.store, "a"); err != nil {
					t.Fatalf("PrepareRetry: %v", err)
				}
			}
			r.step("a", succeed)
			r.step("a", succeed)
			r.sched.Enqueue(ctx, "a", tc.retry)
			r.tick(t, ctx, 1)
			r.sched.Wait()

			run := r.wantState(t, "a", store.DeploySuccess)
			if run.Attempt != tc.wantAttempt {
				t.Errorf("attempt = %d, want %d", run.Attempt, tc.wantAttempt)
			}
			if got := r.strat.ranIndexes(); !slices.Equal(got, tc.wantRan) {
				t.Errorf("ran steps %v, want %v", got, tc.wantRan)
			}
		})
	}
}

// TestScheduler_RecoverRequeuesQueued checks that Recover enqueues the
// Queued runs whose trigger was accepted and leaves a Queued run with no
// answered trigger (a crash before the answer) for the hub's redelivery.
func TestScheduler_RecoverRequeuesQueued(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent.db")
	first := newQueueRig(t, path, oneStep)
	first.insert(t, "p", "production", t0, store.DeployQueued)
	first.insert(t, "s", "staging", t0.Add(time.Second), store.DeployQueued)
	first.insert(t, "bare", "preview", t0, store.DeployQueued)
	first.insert(t, "done", "qa", t0, store.DeploySuccess)
	for _, id := range []string{"p", "s", "done"} {
		if _, err := first.store.AnswerTrigger(ctx, "trg_"+id, id, ""); err != nil {
			t.Fatalf("AnswerTrigger(%s): %v", id, err)
		}
	}
	if err := first.store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	r := newQueueRig(t, path, oneStep)
	if err := r.sched.Recover(ctx); err != nil {
		t.Fatalf("Recover: %v", err)
	}
	r.tick(t, ctx, 2)
	got := []string{r.awaitStart(t), r.awaitStart(t)}
	slices.Sort(got)
	if !slices.Equal(got, []string{"p", "s"}) {
		t.Errorf("started %v after Recover, want [p s]", got)
	}
	r.step("p", succeed)
	r.step("s", succeed)
	r.sched.Wait()
	r.wantState(t, "p", store.DeploySuccess)
	r.wantState(t, "s", store.DeploySuccess)
	r.tick(t, ctx, 0)
	r.wantState(t, "bare", store.DeployQueued)
}

func TestScheduler_RecoverRetryFlag(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent.db")
	twoSteps := []fakeStep{{"build", PhaseApply}, {"start", PhaseApply}}
	first := newQueueRig(t, path, twoSteps)
	first.insert(t, "retried", "production", t0, store.DeployInterrupted)
	if err := first.store.BeginStep(ctx, "retried", 0, "build", nil, t0); err != nil {
		t.Fatalf("BeginStep: %v", err)
	}
	if err := first.store.FinishStep(ctx, "retried", 0, store.StepDone, map[string]string{"build": "out0"}, t0); err != nil {
		t.Fatalf("FinishStep: %v", err)
	}
	if _, err := PrepareRetry(ctx, first.store, "retried"); err != nil {
		t.Fatalf("PrepareRetry: %v", err)
	}
	first.insert(t, "fresh", "staging", t0.Add(time.Second), store.DeployQueued)
	for _, id := range []string{"retried", "fresh"} {
		if _, err := first.store.AnswerTrigger(ctx, "trg_"+id, id, ""); err != nil {
			t.Fatalf("AnswerTrigger(%s): %v", id, err)
		}
	}
	if err := first.store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	r := newQueueRig(t, path, twoSteps)
	if err := r.sched.Recover(ctx); err != nil {
		t.Fatalf("Recover: %v", err)
	}
	r.step("retried", succeed)
	r.step("fresh", succeed)
	r.step("fresh", succeed)
	r.tick(t, ctx, 2)
	r.sched.Wait()
	close(r.starts)
	ran := map[string]int{}
	for id := range r.starts {
		ran[id]++
	}
	if want := map[string]int{"retried": 1, "fresh": 2}; !maps.Equal(ran, want) {
		t.Errorf("steps run per deploy = %v, want %v: the retried run resumes, the fresh one starts", ran, want)
	}
	if run := r.wantState(t, "retried", store.DeploySuccess); run.Attempt != 2 || run.RetryOfState != "" {
		t.Errorf("retried run attempt %d retry_of_state %q, want attempt 2 and no retry mark", run.Attempt, run.RetryOfState)
	}
	if run := r.wantState(t, "fresh", store.DeploySuccess); run.Attempt != 1 {
		t.Errorf("fresh run attempt = %d, want 1", run.Attempt)
	}
}

// blockingCI holds every CI setup until its context ends.
type blockingCI struct{ setups chan string }

func (b blockingCI) RunSetup(ctx context.Context, run store.Run) error {
	b.setups <- run.ID
	<-ctx.Done()
	return ctx.Err()
}

func (blockingCI) RunJob(context.Context, store.Run, store.Job) (scheduler.JobOutcome, error) {
	return scheduler.JobOutcome{State: store.JobSuccess}, nil
}

func (blockingCI) FinishRun(context.Context, store.Run, store.RunState) error { return nil }

func TestScheduler_DoesNotUseCISlots(t *testing.T) {
	ctx := context.Background()
	r := newTestQueue(t)
	ci := blockingCI{setups: make(chan string, 1)}
	pool := scheduler.New(r.store, ci, scheduler.Options{Slots: 1})
	t.Cleanup(func() { _ = pool.Close() })
	if err := r.store.CreateRun(ctx, store.Run{
		ID: "ci", Repo: "acme/web", SHA: testSHA, Ref: "refs/heads/main", Event: "push",
		Kind: "check", TrustDomain: "trusted:acme/web", TriggerID: "trig-ci",
	}, []store.Job{{Name: "test"}}); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if _, err := pool.Submit(ctx, "ci"); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	select {
	case <-ci.setups:
	case <-time.After(10 * time.Second):
		t.Fatal("CI setup did not take the only slot")
	}

	r.insert(t, "d", "production", t0, store.DeployQueued)
	r.sched.Enqueue(ctx, "d", false)
	r.tick(t, ctx, 1)
	if got := r.awaitStart(t); got != "d" {
		t.Fatalf("started %s, want d", got)
	}
	r.step("d", succeed)
	r.sched.Wait()
	r.wantState(t, "d", store.DeploySuccess)
}
