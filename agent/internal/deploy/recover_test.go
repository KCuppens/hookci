package deploy

import (
	"context"
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func TestRecoverer_MarksInterruptedAndStopsUnits(t *testing.T) {
	ctx := context.Background()
	r := newRig(t, store.DeployQueued, fourSteps) // r1, production, Queued
	type seed struct {
		id, env, state string
		steps          []string // status of steps 0..n
		want           string   // error after Recover; "" leaves the run untouched
	}
	seeds := []seed{
		{"r2", "staging", store.DeployRunning, []string{store.StepDone, store.StepRunning},
			"agent restarted during step 2 start; run zeroci retry r2"},
		{"r3", "qa", store.DeployVerifying, []string{store.StepDone, store.StepDone, store.StepRunning},
			"agent restarted during step 3 verify; run zeroci retry r3"},
		{"r4", "eu", store.DeployRollingBack, []string{store.StepDone, store.StepFailed},
			"agent restarted during step 2 start; run zeroci retry r4"},
		{"r5", "us", store.DeploySuccess, []string{store.StepDone, store.StepDone, store.StepDone, store.StepDone}, ""},
	}
	for n, s := range seeds {
		if err := r.store.InsertDeployRun(ctx, store.DeployRun{
			RunID: s.id, Repo: "acme/web", Env: s.env, SHA: "abc123", Ref: "refs/heads/main",
			Strategy: "fake", State: s.state, CreatedAt: t0.Add(time.Duration(n+1) * time.Second),
		}); err != nil {
			t.Fatalf("InsertDeployRun(%s): %v", s.id, err)
		}
		for i, status := range s.steps {
			if err := r.store.BeginStep(ctx, s.id, i, fourSteps[i].name, nil, t0); err != nil {
				t.Fatalf("BeginStep(%s, %d): %v", s.id, i, err)
			}
			if status != store.StepRunning {
				if err := r.store.FinishStep(ctx, s.id, i, status, nil, t0); err != nil {
					t.Fatalf("FinishStep(%s, %d): %v", s.id, i, err)
				}
			}
		}
		if s.want != "" {
			if ok, err := r.store.TryAcquireEnvLock(ctx, "acme/web", s.env, s.id, t0); err != nil || !ok {
				t.Fatalf("TryAcquireEnvLock(%s) = %t, %v", s.id, ok, err)
			}
		}
	}

	fake := &execx.Fake{}
	fake.On("systemctl", []string{"list-units", "--plain", "--no-legend", "zeroci-run-*"}, execx.FakeResponse{Stdout: "" +
		"zeroci-run-r2-deploy.service loaded active running zeroci deploy r2\n" +
		"zeroci-run-r3-deploy.service loaded active running zeroci deploy r3\n" +
		"zeroci-run-ci1-build.service loaded active running zeroci job\n"})
	fake.On("systemctl", []string{"stop", "zeroci-run-r2-deploy"}, execx.FakeResponse{Code: 5, Stderr: "Unit not loaded."})
	fake.On("systemctl", []string{"stop"}, execx.FakeResponse{})
	rec := &Recoverer{Store: r.store, Runner: fake, Events: r.events, Clock: r.clock.Now, Logger: slog.New(slog.DiscardHandler)}
	got, err := rec.Recover(ctx)
	if err != nil {
		t.Fatalf("Recover: %v", err)
	}
	if want := []string{"r2", "r3", "r4"}; !slices.Equal(got, want) {
		t.Errorf("interrupted %v, want %v", got, want)
	}

	var calls []string
	for _, c := range fake.Calls {
		calls = append(calls, c.Name+" "+strings.Join(c.Args, " "))
	}
	wantCalls := []string{
		"systemctl list-units --plain --no-legend zeroci-run-*",
		"systemctl stop zeroci-run-r2-deploy",
		"systemctl stop zeroci-run-r3-deploy",
	}
	if !slices.Equal(calls, wantCalls) {
		t.Errorf("commands = %q, want %q: a failed stop is not fatal and CI units are left alone", calls, wantCalls)
	}

	for _, s := range seeds {
		run, err := r.store.GetDeployRun(ctx, s.id)
		if err != nil {
			t.Fatalf("GetDeployRun(%s): %v", s.id, err)
		}
		holder, held, err := r.store.EnvLockHolder(ctx, "acme/web", s.env)
		if err != nil {
			t.Fatalf("EnvLockHolder(%s): %v", s.env, err)
		}
		if s.want == "" {
			if run.State != s.state || run.Error != "" {
				t.Errorf("%s = %s %q, want untouched %s", s.id, run.State, run.Error, s.state)
			}
			continue
		}
		if run.State != store.DeployInterrupted || run.Error != s.want {
			t.Errorf("%s = %s %q, want Interrupted %q", s.id, run.State, run.Error, s.want)
		}
		if held {
			t.Errorf("%s env lock still held by %s", s.env, holder)
		}
	}
	if run := r.run(t); run.State != store.DeployQueued || run.RetryOfState != "" {
		t.Errorf("queued r1 = %s retry_of %q, want untouched Queued", run.State, run.RetryOfState)
	}

	if len(r.events.events) != 3 {
		t.Fatalf("sent %d events, want one per interrupted run", len(r.events.events))
	}
	for i, ev := range r.events.events {
		s := seeds[i]
		if ev.RunId != s.id || ev.State != protocol.EventStateInterrupted || ev.Job == nil || *ev.Job != JobName ||
			ev.Reason == nil || *ev.Reason != s.want || !slices.Equal(ev.Tail, []string{s.want}) {
			t.Errorf("event %d = %+v, want interrupted %s with reason and tail %q", i, ev, s.id, s.want)
		}
	}
}

func TestRecoverer_ListUnitsErrorStillInterrupts(t *testing.T) {
	r := newRig(t, store.DeployRunning, fourSteps)
	fake := &execx.Fake{}
	fake.On("systemctl", []string{"list-units"}, execx.FakeResponse{Code: 1, Stderr: "Failed to connect to bus"})
	rec := &Recoverer{Store: r.store, Runner: fake, Events: r.events, Clock: r.clock.Now, Logger: slog.New(slog.DiscardHandler)}
	got, err := rec.Recover(context.Background())
	if err != nil || !slices.Equal(got, []string{"r1"}) {
		t.Fatalf("Recover = %v, %v, want [r1]", got, err)
	}
	want := "agent restarted between steps; run zeroci retry r1"
	if run := r.run(t); run.State != store.DeployInterrupted || run.Error != want {
		t.Errorf("run = %s %q, want Interrupted %q", run.State, run.Error, want)
	}
}

// A crash after the scheduler took the env lock but before the engine moved
// the run out of Queued leaves the lock held by a Queued run; Recover frees
// it so the run can deploy again.
func TestRecoverer_ReleasesLockOfQueuedRun(t *testing.T) {
	ctx := context.Background()
	r := newRig(t, store.DeployQueued, fourSteps)
	if ok, err := r.store.TryAcquireEnvLock(ctx, "acme/web", "production", "r1", t0); err != nil || !ok {
		t.Fatalf("TryAcquireEnvLock = %t, %v", ok, err)
	}
	rec := &Recoverer{Store: r.store, Runner: &execx.Fake{}, Events: r.events, Clock: r.clock.Now, Logger: slog.New(slog.DiscardHandler)}
	if _, err := rec.Recover(ctx); err != nil {
		t.Fatalf("Recover: %v", err)
	}
	if holder, held, err := r.store.EnvLockHolder(ctx, "acme/web", "production"); err != nil || held {
		t.Fatalf("lock holder = %q, %t, %v; want free", holder, held, err)
	}
	if run := r.run(t); run.State != store.DeployQueued {
		t.Errorf("r1 = %s, want untouched Queued", run.State)
	}
}
