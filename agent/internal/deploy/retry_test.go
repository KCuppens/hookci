package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// blueGreenSteps mirrors the compose-bluegreen plan.
var blueGreenSteps = []fakeStep{
	{"build", PhaseApply}, {"prepare", PhaseApply}, {"migrate", PhaseApply}, {"start", PhaseApply},
	{"health", PhaseApply}, {"swap", PhaseApply}, {"verify", PhaseVerify}, {"finalize", PhaseVerify},
}

// fakeSched records Enqueue calls.
type fakeSched struct{ enqueued []string }

func (f *fakeSched) Enqueue(_ context.Context, runID string, retry bool) {
	f.enqueued = append(f.enqueued, fmt.Sprintf("%s retry=%t", runID, retry))
}

// crashAt starts r1 and kills the agent, by cancelling, in step i.
func crashAt(t *testing.T, r *testRig, i int) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.strat.hook = func(ctx context.Context, _ *StepContext, j int) error {
		if j == i {
			cancel()
			return ctx.Err()
		}
		return nil
	}
	if err := r.engine.Start(ctx, "r1"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Start err = %v, want context.Canceled", err)
	}
	r.strat.hook = nil
}

// restart runs the agent-start Recoverer over the rig's store with no
// leftover units.
func restart(t *testing.T, r *testRig) {
	t.Helper()
	fake := &execx.Fake{}
	fake.On("systemctl", []string{"list-units"}, execx.FakeResponse{})
	rec := &Recoverer{Store: r.store, Runner: fake, Events: r.events, Clock: r.clock.Now, Logger: slog.New(slog.DiscardHandler)}
	if _, err := rec.Recover(context.Background()); err != nil {
		t.Fatalf("Recover: %v", err)
	}
}

// retry requests a retry of r1, then runs the engine retry with fresh
// strategy records.
func retry(t *testing.T, r *testRig) error {
	t.Helper()
	sched := &fakeSched{}
	id, err := RequestRetry(context.Background(), r.store, sched, "r1")
	if err != nil {
		t.Fatalf("RequestRetry: %v", err)
	}
	if want := []string{"r1 retry=true"}; id != "r1" || !slices.Equal(sched.enqueued, want) {
		t.Fatalf("RequestRetry = %q, enqueued %v, want r1 and %v", id, sched.enqueued, want)
	}
	r.strat.ran, r.strat.rollbacks = nil, nil
	return r.engine.Retry(context.Background(), "r1")
}

func TestEngine_RetryFailedRestartsFromZero(t *testing.T) {
	r := newRig(t, store.DeployQueued, fourSteps)
	r.strat.failAt = map[int]error{2: errors.New("health check timed out")}
	if err := r.engine.Start(context.Background(), "r1"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if run := r.run(t); run.State != store.DeployFailed {
		t.Fatalf("run = %s, want Failed before the retry", run.State)
	}
	r.strat.failAt = nil
	before := len(r.events.events)

	if err := retry(t, r); err != nil {
		t.Fatalf("Retry: %v", err)
	}
	if got := r.strat.ranIndexes(); !slices.Equal(got, []int{0, 1, 2, 3}) {
		t.Errorf("ran steps %v, want every step from 0", got)
	}
	if got := r.strat.ran[0].outputs; len(got) != 0 {
		t.Errorf("step 0 started with outputs %v, want none", got)
	}
	if len(r.strat.rollbacks) != 0 {
		t.Errorf("Rollback called %v, want none: the failed run already rolled back", r.strat.rollbacks)
	}
	run := r.run(t)
	if run.State != store.DeploySuccess || run.Attempt != 2 || run.Error != "" || run.RetryOfState != "" {
		t.Errorf("run = %s attempt %d error %q retry_of %q, want Success attempt 2 with no error or retry mark",
			run.State, run.Attempt, run.Error, run.RetryOfState)
	}
	steps := r.steps(t)
	if len(steps) != len(fourSteps) {
		t.Fatalf("%d steps recorded, want %d", len(steps), len(fourSteps))
	}
	for _, st := range steps {
		if st.Status != store.StepDone {
			t.Errorf("step %d status = %s, want done", st.Index, st.Status)
		}
	}
	got := (&fakeEvents{events: r.events.events[before:]}).states()
	want := []protocol.EventState{protocol.EventStateRunning, protocol.EventStateVerifying, protocol.EventStateSuccess}
	if !slices.Equal(got, want) {
		t.Errorf("retry events %v, want %v", got, want)
	}
	if len(r.events.planned) != 2 {
		t.Errorf("sent %d job_planned frames, want 2: the retry plans again from step 0", len(r.events.planned))
	}
}

func TestEngine_RetryInterruptedResumes(t *testing.T) {
	for i, step := range blueGreenSteps {
		t.Run(step.name, func(t *testing.T) {
			r := newRig(t, store.DeployQueued, blueGreenSteps)
			crashAt(t, r, i)
			restart(t, r)
			want := fmt.Sprintf("agent restarted during step %d %s; run hookci retry r1", i+1, step.name)
			if run := r.run(t); run.State != store.DeployInterrupted || run.Error != want {
				t.Fatalf("after restart run = %s %q, want Interrupted %q", run.State, run.Error, want)
			}

			if err := retry(t, r); err != nil {
				t.Fatalf("Retry: %v", err)
			}
			var wantRan []int
			wantIn := map[string]string{}
			for j := range blueGreenSteps {
				if j >= i {
					wantRan = append(wantRan, j)
				} else {
					wantIn[blueGreenSteps[j].name] = fmt.Sprintf("out%d", j)
				}
			}
			if got := r.strat.ranIndexes(); !slices.Equal(got, wantRan) {
				t.Fatalf("ran steps %v, want %v", got, wantRan)
			}
			if got := r.strat.ran[0].outputs; !maps.Equal(got, wantIn) {
				t.Errorf("step %d restarted with outputs %v, want %v", i, got, wantIn)
			}
			if len(r.strat.rollbacks) != 0 {
				t.Errorf("Rollback called %v, want none", r.strat.rollbacks)
			}
			run := r.run(t)
			if run.State != store.DeploySuccess || run.Attempt != 2 || run.RetryOfState != "" {
				t.Errorf("run = %s attempt %d retry_of %q, want Success attempt 2 with no retry mark",
					run.State, run.Attempt, run.RetryOfState)
			}
			if len(r.events.planned) != 1 {
				t.Errorf("sent %d job_planned frames, want only the first run's", len(r.events.planned))
			}
		})
	}
}

func TestEngine_RetryInterruptedDuringRollbackFinishesRollback(t *testing.T) {
	// interruptRollback fails step 2 and kills the agent during its rollback.
	interruptRollback := func(t *testing.T) *testRig {
		t.Helper()
		r := newRig(t, store.DeployQueued, fourSteps)
		r.strat.failAt = map[int]error{2: errors.New("health check timed out")}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		r.strat.rollbackHook = func(*StepContext, int) { cancel() }
		r.strat.rollbackErr = context.Canceled
		if err := r.engine.Start(ctx, "r1"); !errors.Is(err, context.Canceled) {
			t.Fatalf("Start err = %v, want context.Canceled", err)
		}
		if run := r.run(t); run.State != store.DeployRollingBack {
			t.Fatalf("run = %s, want RollingBack after the crash", run.State)
		}
		r.strat.failAt, r.strat.rollbackHook, r.strat.rollbackErr = nil, nil, nil
		restart(t, r)
		want := "agent restarted during step 3 verify; run hookci retry r1"
		if run := r.run(t); run.State != store.DeployInterrupted || run.Error != want {
			t.Fatalf("after restart run = %s %q, want Interrupted %q", run.State, run.Error, want)
		}
		return r
	}

	t.Run("rollback succeeds", func(t *testing.T) {
		r := interruptRollback(t)
		var ranBefore int
		var rollbackIn map[string]string
		r.strat.rollbackHook = func(sc *StepContext, _ int) {
			ranBefore = len(r.strat.ranIndexes())
			rollbackIn = maps.Clone(sc.Outputs)
		}
		before := len(r.events.events)
		if err := retry(t, r); err != nil {
			t.Fatalf("Retry: %v", err)
		}
		if !slices.Equal(r.strat.rollbacks, []int{2}) || ranBefore != 0 {
			t.Fatalf("rollbacks %v after %d steps, want [2] before any step", r.strat.rollbacks, ranBefore)
		}
		if want := map[string]string{"build": "out0", "start": "out1"}; !maps.Equal(rollbackIn, want) {
			t.Errorf("rollback outputs %v, want the failed step's %v", rollbackIn, want)
		}
		if got := r.strat.ranIndexes(); !slices.Equal(got, []int{0, 1, 2, 3}) {
			t.Errorf("ran steps %v, want every step from 0", got)
		}
		if got := r.strat.ran[0].outputs; len(got) != 0 {
			t.Errorf("step 0 started with outputs %v, want none", got)
		}
		run := r.run(t)
		if run.State != store.DeploySuccess || run.Attempt != 2 || run.RetryOfState != "" {
			t.Errorf("run = %s attempt %d retry_of %q, want Success attempt 2 with no retry mark",
				run.State, run.Attempt, run.RetryOfState)
		}
		got := (&fakeEvents{events: r.events.events[before:]}).states()
		want := []protocol.EventState{protocol.EventStateRollingBack, protocol.EventStateRunning,
			protocol.EventStateVerifying, protocol.EventStateSuccess}
		if !slices.Equal(got, want) {
			t.Errorf("retry events %v, want %v", got, want)
		}
	})

	t.Run("rollback fails again", func(t *testing.T) {
		r := interruptRollback(t)
		r.strat.rollbackErr = errors.New("restore route: permission denied")
		if err := retry(t, r); err != nil {
			t.Fatalf("Retry: %v", err)
		}
		if !slices.Equal(r.strat.rollbacks, []int{2}) || len(r.strat.ran) != 0 {
			t.Errorf("rollbacks %v, ran %v, want rollback of 2 and no steps", r.strat.rollbacks, r.strat.ranIndexes())
		}
		run := r.run(t)
		want := "deployments.production: rollback after restart failed: restore route: permission denied"
		if run.State != store.DeployFailed || run.Error != want || run.RetryOfState != "" {
			t.Errorf("run = %s %q retry_of %q, want Failed %q with no retry mark", run.State, run.Error, run.RetryOfState, want)
		}
		if last := r.events.last(); last.State != protocol.EventStateFailed || last.Reason == nil || *last.Reason != want {
			t.Errorf("last event = %+v, want failed with reason %q", last, want)
		}
	})
}

func TestEngine_RetryRequiresQueuedRetry(t *testing.T) {
	for _, state := range []string{store.DeployQueued, store.DeployFailed, store.DeployInterrupted} {
		t.Run(state, func(t *testing.T) {
			r := newRig(t, state, fourSteps)
			if err := r.engine.Retry(context.Background(), "r1"); !errors.Is(err, ErrNotRetryable) {
				t.Errorf("Retry err = %v, want ErrNotRetryable", err)
			}
			if len(r.strat.ran) != 0 || len(r.events.events) != 0 {
				t.Errorf("ran %v and sent %d events, want nothing", r.strat.ranIndexes(), len(r.events.events))
			}
		})
	}
}

func TestRequestRetry_RejectsSuccessAndRunning(t *testing.T) {
	for _, state := range []string{store.DeployQueued, store.DeployRunning, store.DeployVerifying,
		store.DeployRollingBack, store.DeploySuccess, store.DeploySuperseded} {
		t.Run(state, func(t *testing.T) {
			r := newRig(t, state, fourSteps)
			sched := &fakeSched{}
			if _, err := RequestRetry(context.Background(), r.store, sched, "r1"); !errors.Is(err, ErrNotRetryable) {
				t.Errorf("RequestRetry err = %v, want ErrNotRetryable", err)
			}
			if len(sched.enqueued) != 0 {
				t.Errorf("enqueued %v, want nothing", sched.enqueued)
			}
			if run := r.run(t); run.State != state || run.Attempt != 1 || run.RetryOfState != "" {
				t.Errorf("run = %s attempt %d retry_of %q, want unchanged", run.State, run.Attempt, run.RetryOfState)
			}
		})
	}
	for _, state := range []string{store.DeployFailed, store.DeployInterrupted} {
		t.Run(state, func(t *testing.T) {
			r := newRig(t, state, fourSteps)
			sched := &fakeSched{}
			id, err := RequestRetry(context.Background(), r.store, sched, "r1")
			if err != nil || id != "r1" {
				t.Fatalf("RequestRetry = %q, %v, want r1", id, err)
			}
			if want := []string{"r1 retry=true"}; !slices.Equal(sched.enqueued, want) {
				t.Errorf("enqueued %v, want %v", sched.enqueued, want)
			}
			if run := r.run(t); run.State != store.DeployQueued || run.Attempt != 2 || run.RetryOfState != state {
				t.Errorf("run = %s attempt %d retry_of %q, want Queued attempt 2 retry_of %s",
					run.State, run.Attempt, run.RetryOfState, state)
			}
		})
	}
	r := newRig(t, store.DeployFailed, fourSteps)
	if _, err := RequestRetry(context.Background(), r.store, &fakeSched{}, "missing"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("RequestRetry(missing) err = %v, want ErrNotFound", err)
	}
}

func TestRetryControl(t *testing.T) {
	call := func(r *testRig, sched Enqueuer, body string) (any, error) {
		h := RetryControl(r.store, sched)
		return h(context.Background(), json.RawMessage(body))
	}

	r := newRig(t, store.DeployInterrupted, fourSteps)
	sched := &fakeSched{}
	got, err := call(r, sched, `{"run_id":"r1"}`)
	if err != nil || got != (RetryReply{RunID: "r1", Attempt: 2}) {
		t.Errorf("retry = %+v, %v, want r1 attempt 2", got, err)
	}
	if want := []string{"r1 retry=true"}; !slices.Equal(sched.enqueued, want) {
		t.Errorf("enqueued %v, want %v", sched.enqueued, want)
	}

	for _, tc := range []struct{ name, state, body, want string }{
		{"success", store.DeploySuccess, `{"run_id":"r1"}`, "run r1 is Success; only Failed or Interrupted runs can be retried"},
		{"running", store.DeployRunning, `{"run_id":"r1"}`, "run r1 is Running; only Failed or Interrupted runs can be retried"},
		{"missing", store.DeployFailed, `{"run_id":"r9"}`, "no deploy run r9"},
		{"no run id", store.DeployFailed, `{}`, "retry needs a run id"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t, tc.state, fourSteps)
			sched := &fakeSched{}
			if got, err := call(r, sched, tc.body); err == nil || err.Error() != tc.want {
				t.Errorf("retry = %+v, %v, want error %q", got, err, tc.want)
			}
			if len(sched.enqueued) != 0 {
				t.Errorf("enqueued %v, want nothing", sched.enqueued)
			}
		})
	}
}
