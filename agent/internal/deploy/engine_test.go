package deploy

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/redact"
	"github.com/KCuppens/hookci/agent/internal/store"
)

func TestEngine_HappyPath(t *testing.T) {
	ctx := context.Background()
	r := newRig(t, store.DeployQueued, fourSteps)
	r.strat.hook = func(_ context.Context, sc *StepContext, i int) error {
		if sc.Run.RunID != "r1" || sc.Cfg.Strategy != "compose-inplace" || sc.Exec == nil || sc.Log == nil || sc.Clock == nil {
			t.Errorf("step %d context = %+v, want run, config, executor, log and clock", i, sc)
		}
		if i == 1 {
			sc.Outputs["color"] = "green"
		}
		return nil
	}
	if err := r.engine.Start(ctx, "r1"); err != nil {
		t.Fatalf("Start: %v", err)
	}

	run := r.run(t)
	if run.State != store.DeploySuccess || run.Error != "" || run.Attempt != 1 {
		t.Errorf("run = %s %q attempt %d, want Success with no error, attempt 1", run.State, run.Error, run.Attempt)
	}
	want := []protocol.EventState{protocol.EventStateRunning, protocol.EventStateVerifying, protocol.EventStateSuccess}
	if got := r.events.states(); !slices.Equal(got, want) {
		t.Errorf("event states = %v, want %v", got, want)
	}
	if got := r.events.runStates(); !slices.Equal(got, want) {
		t.Errorf("run event states = %v, want %v once each", got, want)
	}
	if end := r.events.runs[len(r.events.runs)-1]; end.RunId != "r1" || end.DurationMs == nil || *end.DurationMs != int(4*stepTime.Milliseconds()) {
		t.Errorf("run's last event = %+v, want r1 with duration %d", end, 4*stepTime.Milliseconds())
	}

	var stepEvents []protocol.Event
	for _, ev := range r.events.events {
		if ev.Job == nil || *ev.Job != JobName || ev.RunId != "r1" {
			t.Errorf("event %+v: want run r1 job %s", ev, JobName)
		}
		if ev.Step != nil {
			stepEvents = append(stepEvents, ev)
		}
	}
	if len(stepEvents) != len(fourSteps) {
		t.Fatalf("%d step events, want %d", len(stepEvents), len(fourSteps))
	}
	for i, ev := range stepEvents {
		wantState := protocol.EventStateRunning
		if fourSteps[i].phase == PhaseVerify {
			wantState = protocol.EventStateVerifying
		}
		if *ev.Step != fourSteps[i].name || ev.StepIndex == nil || *ev.StepIndex != i ||
			ev.StepsTotal == nil || *ev.StepsTotal != 4 || ev.State != wantState {
			t.Errorf("step event %d = %s step %s index %v total %v, want %s step %s index %d total 4",
				i, ev.State, *ev.Step, ev.StepIndex, ev.StepsTotal, wantState, fourSteps[i].name, i)
		}
	}
	last := r.events.last()
	if last.State != protocol.EventStateSuccess || last.DurationMs == nil || *last.DurationMs != int(4*stepTime.Milliseconds()) {
		t.Errorf("last event = %s duration %v, want success with duration %d", last.State, last.DurationMs, 4*stepTime.Milliseconds())
	}

	if len(r.events.planned) != 1 {
		t.Fatalf("%d job_planned frames, want 1", len(r.events.planned))
	}
	jp := r.events.planned[0]
	if jp.RunId != "r1" || jp.Env == nil || *jp.Env != "production" || len(jp.Jobs) != 1 ||
		jp.Jobs[0].Name != JobName || jp.Jobs[0].Needs == nil || len(jp.Jobs[0].Needs) != 0 {
		t.Errorf("job_planned = %+v, want run r1 env production jobs [deploy needs []]", jp)
	}

	for i, st := range r.steps(t) {
		if st.Index != i || st.Name != fourSteps[i].name || st.Status != store.StepDone {
			t.Errorf("step row %d = %d %s %s, want %d %s done", i, st.Index, st.Name, st.Status, i, fourSteps[i].name)
		}
	}
	ds, ok, err := r.store.GetDeployState(ctx, "acme/web", "production")
	if err != nil || !ok {
		t.Fatalf("GetDeployState = %v, %v", ok, err)
	}
	if ds.ActiveColor != "green" || ds.LastSuccessSHA != "abc123" || ds.LastSuccessRun != "r1" {
		t.Errorf("deploy_state = %+v, want green abc123 r1", ds)
	}
}

func TestEngine_StepPersistedBeforeRun(t *testing.T) {
	r := newRig(t, store.DeployQueued, fourSteps)
	r.strat.hook = func(ctx context.Context, sc *StepContext, i int) error {
		steps, err := r.store.ListSteps(ctx, "r1")
		if err != nil {
			return err
		}
		if len(steps) != i+1 {
			t.Fatalf("step %d sees %d rows, want %d", i, len(steps), i+1)
		}
		own := steps[i]
		if own.Name != fourSteps[i].name || own.Status != store.StepRunning {
			t.Errorf("step %d sees its row as %s %s, want %s running", i, own.Name, own.Status, fourSteps[i].name)
		}
		if !maps.Equal(own.Outputs, sc.Outputs) {
			t.Errorf("step %d row outputs = %v, want the outputs it starts with %v", i, own.Outputs, sc.Outputs)
		}
		return nil
	}
	if err := r.engine.Start(context.Background(), "r1"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := r.strat.ranIndexes(); !slices.Equal(got, []int{0, 1, 2, 3}) {
		t.Errorf("ran steps %v, want 0-3", got)
	}
}

func TestEngine_FailureRollsBack(t *testing.T) {
	r := newRig(t, store.DeployQueued, fourSteps)
	r.strat.failAt = map[int]error{2: errors.New("health check timed out")}
	r.strat.hook = func(_ context.Context, sc *StepContext, i int) error {
		for n := range 100 {
			fmt.Fprintf(sc.Log, "step %d line %d\n", i, n)
		}
		return nil
	}
	if err := r.engine.Start(context.Background(), "r1"); err != nil {
		t.Fatalf("Start: %v", err)
	}

	if !slices.Equal(r.strat.rollbacks, []int{2}) {
		t.Errorf("Rollback calls = %v, want [2]", r.strat.rollbacks)
	}
	if got := r.strat.ranIndexes(); !slices.Equal(got, []int{0, 1, 2}) {
		t.Errorf("ran steps %v, want 0-2", got)
	}
	run := r.run(t)
	wantErr := "deployments.production: step verify failed: health check timed out"
	if run.State != store.DeployFailed || run.Error != wantErr || run.FinishedAt.IsZero() {
		t.Errorf("run = %s %q finished %v, want Failed %q with finished_at", run.State, run.Error, run.FinishedAt, wantErr)
	}
	if !strings.HasPrefix(run.Error, "deployments.production: step") {
		t.Errorf("error %q does not start with deployments.production: step", run.Error)
	}
	if st := r.steps(t)[2]; st.Status != store.StepFailed {
		t.Errorf("step 2 status = %s, want failed", st.Status)
	}

	want := []protocol.EventState{protocol.EventStateRunning, protocol.EventStateVerifying,
		protocol.EventStateRollingBack, protocol.EventStateFailed}
	if got := r.events.states(); !slices.Equal(got, want) {
		t.Errorf("event states = %v, want %v", got, want)
	}
	if got := r.events.runStates(); !slices.Equal(got, want) {
		t.Errorf("run event states = %v, want %v once each", got, want)
	}
	last := r.events.last()
	if end := r.events.runs[len(r.events.runs)-1]; end.Reason == nil || *end.Reason != wantErr || end.DurationMs == nil || !slices.Equal(end.Tail, last.Tail) {
		t.Errorf("run's last event = %+v, want the reason, duration and the job's tail", end)
	}

	if last.State != protocol.EventStateFailed || last.Reason == nil || *last.Reason != wantErr ||
		last.StepIndex == nil || *last.StepIndex != 2 || last.DurationMs == nil {
		t.Errorf("last event = %+v, want failed at step 2 with reason and duration", last)
	}
	if len(last.Tail) == 0 || len(last.Tail) > TailLines {
		t.Fatalf("tail has %d lines, want 1-%d", len(last.Tail), TailLines)
	}
	if got := last.Tail[len(last.Tail)-1]; got != wantErr {
		t.Errorf("last tail line = %q, want %q", got, wantErr)
	}
	if got := last.Tail[len(last.Tail)-2]; got != "step 2 line 99" {
		t.Errorf("tail line before the error = %q, want the step's last line", got)
	}
}

func TestEngine_ResumeFromFirstUnfinished(t *testing.T) {
	ctx := context.Background()
	r := newRig(t, store.DeployInterrupted, fourSteps)
	done := []map[string]string{{"image": "web:abc123"}, {"color": "green", "port": "20001"}}
	for i, out := range done {
		if err := r.store.BeginStep(ctx, "r1", i, fourSteps[i].name, nil, t0); err != nil {
			t.Fatalf("BeginStep(%d): %v", i, err)
		}
		if err := r.store.FinishStep(ctx, "r1", i, store.StepDone, out, t0); err != nil {
			t.Fatalf("FinishStep(%d): %v", i, err)
		}
	}
	if err := r.store.BeginStep(ctx, "r1", 2, fourSteps[2].name, maps.Clone(done[1]), t0); err != nil {
		t.Fatalf("BeginStep(2): %v", err)
	}

	if err := r.engine.Resume(ctx, "r1"); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if got := r.strat.ranIndexes(); !slices.Equal(got, []int{2, 3}) {
		t.Fatalf("ran steps %v, want [2 3]", got)
	}
	wantIn := map[string]string{"image": "web:abc123", "color": "green", "port": "20001"}
	if got := r.strat.ran[0].outputs; !maps.Equal(got, wantIn) {
		t.Errorf("step 2 started with outputs %v, want %v", got, wantIn)
	}
	run := r.run(t)
	if run.State != store.DeploySuccess || run.Attempt != 2 {
		t.Errorf("run = %s attempt %d, want Success attempt 2", run.State, run.Attempt)
	}
	for _, st := range r.steps(t) {
		if st.Status != store.StepDone {
			t.Errorf("step %d status = %s, want done", st.Index, st.Status)
		}
	}
	if len(r.events.planned) != 0 {
		t.Errorf("Resume sent %d job_planned frames, want 0", len(r.events.planned))
	}
	if ds, _, _ := r.store.GetDeployState(ctx, "acme/web", "production"); ds.ActiveColor != "green" {
		t.Errorf("active color = %q, want green from step 1", ds.ActiveColor)
	}
}

func TestEngine_NoTailOnSuccess(t *testing.T) {
	tests := []struct {
		name  string
		state string
		run   func(e *Engine) error
	}{
		{"start", store.DeployQueued, func(e *Engine) error { return e.Start(context.Background(), "r1") }},
		{"resume", store.DeployInterrupted, func(e *Engine) error { return e.Resume(context.Background(), "r1") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newRig(t, tt.state, fourSteps)
			r.strat.hook = func(_ context.Context, sc *StepContext, i int) error {
				fmt.Fprintf(sc.Log, "step %d output\n", i)
				return nil
			}
			if err := tt.run(r.engine); err != nil {
				t.Fatalf("run: %v", err)
			}
			if r.events.last().State != protocol.EventStateSuccess {
				t.Fatalf("last event state = %s, want success", r.events.last().State)
			}
			for _, ev := range append(r.events.events, r.events.runs...) {
				if ev.Tail != nil {
					t.Errorf("%s event carries tail %v", ev.State, ev.Tail)
				}
			}
		})
	}
}

func TestEngine_RollbackErrorStillFailed(t *testing.T) {
	r := newRig(t, store.DeployQueued, fourSteps)
	r.strat.failAt = map[int]error{1: errors.New("container exited 1")}
	r.strat.rollbackErr = errors.New("restore route: permission denied")
	if err := r.engine.Start(context.Background(), "r1"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	run := r.run(t)
	wantErr := "deployments.production: step start failed: container exited 1; rollback failed: restore route: permission denied"
	if run.State != store.DeployFailed || run.Error != wantErr {
		t.Errorf("run = %s %q, want Failed %q", run.State, run.Error, wantErr)
	}
	last := r.events.last()
	if last.State != protocol.EventStateFailed || last.Reason == nil || *last.Reason != wantErr {
		t.Errorf("last event = %s reason %v, want failed %q", last.State, last.Reason, wantErr)
	}
	if !slices.Contains(last.Tail, "rollback failed: restore route: permission denied") {
		t.Errorf("tail %v lacks the rollback error", last.Tail)
	}
}

func TestEngine_CancelLeavesState(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := newRig(t, store.DeployQueued, fourSteps)
	r.strat.hook = func(ctx context.Context, _ *StepContext, i int) error {
		if i == 2 {
			cancel()
			return ctx.Err()
		}
		return nil
	}
	if err := r.engine.Start(ctx, "r1"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Start err = %v, want context.Canceled", err)
	}
	if len(r.strat.rollbacks) != 0 {
		t.Errorf("Rollback called %v on cancel", r.strat.rollbacks)
	}
	if run := r.run(t); run.State != store.DeployVerifying || run.Error != "" {
		t.Errorf("run = %s %q, want Verifying with no error", run.State, run.Error)
	}
	if st := r.steps(t)[2]; st.Status != store.StepRunning {
		t.Errorf("step 2 status = %s, want running", st.Status)
	}
	if last := r.events.last(); last.State != protocol.EventStateVerifying {
		t.Errorf("last event state = %s, want verifying", last.State)
	}
}

func TestEngine_RequiresQueuedOrInterrupted(t *testing.T) {
	for _, state := range []string{store.DeployRunning, store.DeployVerifying, store.DeployRollingBack,
		store.DeploySuccess, store.DeployFailed, store.DeploySuperseded} {
		for name, run := range map[string]func(*Engine) error{
			"start":  func(e *Engine) error { return e.Start(context.Background(), "r1") },
			"resume": func(e *Engine) error { return e.Resume(context.Background(), "r1") },
		} {
			t.Run(state+"/"+name, func(t *testing.T) {
				r := newRig(t, state, fourSteps)
				if err := run(r.engine); err == nil || !strings.Contains(err.Error(), "want Queued or Interrupted") {
					t.Errorf("err = %v, want refusal", err)
				}
				if got := r.run(t); got.State != state || got.Attempt != 1 {
					t.Errorf("run = %s attempt %d, want unchanged %s attempt 1", got.State, got.Attempt, state)
				}
				if len(r.strat.ran) != 0 || len(r.events.events) != 0 {
					t.Errorf("ran %v and sent %d events, want nothing", r.strat.ranIndexes(), len(r.events.events))
				}
			})
		}
	}
	r := newRig(t, store.DeployQueued, fourSteps)
	if err := r.engine.Start(context.Background(), "missing"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("Start(missing) err = %v, want ErrNotFound", err)
	}
}

func TestEngine_FailsBeforeSteps(t *testing.T) {
	tests := []struct {
		name    string
		setup   func(r *testRig)
		wantErr string
	}{
		{
			name:    "unknown strategy",
			setup:   func(r *testRig) { r.engine.Strategies = map[string]DeployStrategy{"script": r.strat} },
			wantErr: "deployments.production.strategy: fake is not a strategy this agent runs; it runs script",
		},
		{
			name: "config load error",
			setup: func(r *testRig) {
				r.engine.LoadDeployment = func(context.Context, store.DeployRun) (config.Deployment, error) {
					return config.Deployment{}, errors.New("fetch hookci.yml at abc123: 404")
				}
			},
			wantErr: "deployments.production: load config: fetch hookci.yml at abc123: 404",
		},
		{
			name:    "plan error",
			setup:   func(r *testRig) { r.strat.planErr = errors.New("route.file is not absolute") },
			wantErr: "deployments.production: plan fake: route.file is not absolute",
		},
		{
			name: "executor refused before checkout",
			setup: func(r *testRig) {
				r.engine.NewExecutor = func(context.Context, store.DeployRun, config.Deployment) (Executor, error) {
					return nil, ErrUntrustedDeploy
				}
				r.engine.Checkout = func(context.Context, store.DeployRun) error { return errors.New("checkout ran") }
			},
			wantErr: "deployments.production: executor: deploy: run is not trusted",
		},
		{
			name: "checkout error",
			setup: func(r *testRig) {
				r.engine.Checkout = func(context.Context, store.DeployRun) error { return errors.New("fetch: repository not found") }
			},
			wantErr: "deployments.production: checkout acme/web@abc123: fetch: repository not found",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newRig(t, store.DeployQueued, fourSteps)
			tt.setup(r)
			if err := r.engine.Start(context.Background(), "r1"); err != nil {
				t.Fatalf("Start: %v", err)
			}
			if run := r.run(t); run.State != store.DeployFailed || run.Error != tt.wantErr {
				t.Errorf("run = %s %q, want Failed %q", run.State, run.Error, tt.wantErr)
			}
			if len(r.strat.ran) != 0 || len(r.strat.rollbacks) != 0 || len(r.steps(t)) != 0 {
				t.Errorf("ran %v, rolled back %v, want no steps", r.strat.ranIndexes(), r.strat.rollbacks)
			}
			want := []protocol.EventState{protocol.EventStateRunning, protocol.EventStateFailed}
			if got := r.events.states(); !slices.Equal(got, want) {
				t.Errorf("event states = %v, want %v", got, want)
			}
			if last := r.events.last(); last.Reason == nil || *last.Reason != tt.wantErr || last.Step != nil {
				t.Errorf("last event = %+v, want reason %q and no step", last, tt.wantErr)
			}
		})
	}
}

func TestEngine_PreflightFailure_NoStepsNoRollback(t *testing.T) {
	r := newRig(t, store.DeployQueued, fourSteps)
	checkedOut := false
	r.engine.Checkout = func(context.Context, store.DeployRun) error { checkedOut = true; return nil }
	r.engine.Preflight = []PreflightFunc{DiskPreflight(fakeDockerInfo("/var/lib/docker"), "/var/lib/hookci", 5*gib,
		statfsMap(map[string]uint64{"/var/lib/docker": 1 * gib, "/var/lib/hookci": 50 * gib}))}
	if err := r.engine.Start(context.Background(), "r1"); err != nil {
		t.Fatalf("Start: %v", err)
	}

	wantErr := "gc.min_free_bytes: free disk 1073741824 on /var/lib/docker below 5368709120; run hookci gc or raise the limit"
	if run := r.run(t); run.State != store.DeployFailed || run.Error != wantErr || run.FinishedAt.IsZero() {
		t.Errorf("run = %s %q finished %v, want Failed %q", run.State, run.Error, run.FinishedAt, wantErr)
	}
	if steps := r.steps(t); len(steps) != 0 {
		t.Errorf("deploy_steps rows = %d, want 0", len(steps))
	}
	if len(r.strat.rollbacks) != 0 || len(r.strat.ran) != 0 || checkedOut {
		t.Errorf("rolled back %v, ran %v, checked out %v; want nothing", r.strat.rollbacks, r.strat.ranIndexes(), checkedOut)
	}
	if last := r.events.last(); last.State != protocol.EventStateFailed || last.Reason == nil || *last.Reason != wantErr || last.Step != nil {
		t.Errorf("last event = %+v, want failed with reason %q and no step", last, wantErr)
	}
}

func TestEngine_PreflightPasses(t *testing.T) {
	r := newRig(t, store.DeployQueued, fourSteps)
	r.engine.Preflight = []PreflightFunc{DiskPreflight(fakeDockerInfo("/var/lib/docker"), "/var/lib/hookci", 5*gib,
		statfsMap(map[string]uint64{"/var/lib/docker": 6 * gib, "/var/lib/hookci": 50 * gib}))}
	if err := r.engine.Start(context.Background(), "r1"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if run := r.run(t); run.State != store.DeploySuccess {
		t.Errorf("run state = %s %q, want success", run.State, run.Error)
	}
	if got := r.strat.ranIndexes(); !slices.Equal(got, []int{0, 1, 2, 3}) {
		t.Errorf("ran steps %v, want 0-3", got)
	}
}

func fakeDockerInfo(root string) *execx.Fake {
	fake := &execx.Fake{}
	fake.On("docker", []string{"info", "--format", "{{.DockerRootDir}}"}, execx.FakeResponse{Stdout: root + "\n"})
	return fake
}

func TestEngine_LogRedacted(t *testing.T) {
	token := "ghp_" + strings.Repeat("a", 36)
	r := newRig(t, store.DeployQueued, fourSteps)
	r.strat.hook = func(_ context.Context, sc *StepContext, i int) error {
		fmt.Fprintf(sc.Log, "pushing with %s\n", token)
		return errors.New("push denied")
	}
	if err := r.engine.Start(context.Background(), "r1"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	tail := r.events.last().Tail
	if !slices.Contains(tail, "pushing with "+redact.Mask) {
		t.Errorf("tail %q lacks the masked line", tail)
	}
	if strings.Contains(strings.Join(tail, "\n"), token) {
		t.Errorf("tail %q leaks the token", tail)
	}
}

// TestEngine_EnvFileValuesMaskedInLogAndReason checks that an env_file value
// the executor masks is masked in the strategy's own log lines, the stored run
// error and the event reason too, such as a health check quoting a response
// body.
func TestEngine_EnvFileValuesMaskedInLogAndReason(t *testing.T) {
	const secret = "pg-pass-0f9e8d7c"
	r := newRig(t, store.DeployQueued, fourSteps)
	r.engine.NewExecutor = func(context.Context, store.DeployRun, config.Deployment) (Executor, error) {
		return &UnitExecutor{Runner: &execx.Fake{}, RunID: "r1", Secrets: []string{secret}}, nil
	}
	r.strat.hook = func(_ context.Context, sc *StepContext, i int) error {
		fmt.Fprintf(sc.Log, "connecting to postgres://app:%s@db\n", secret)
		return fmt.Errorf("deployments.production.health: 500 after 3 tries, last body: password=%s", secret)
	}
	if err := r.engine.Start(context.Background(), "r1"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	run := r.run(t)
	if run.State != store.DeployFailed || strings.Contains(run.Error, secret) || !strings.Contains(run.Error, "password="+redact.Mask) {
		t.Errorf("run = %s %q, want failed with the env_file value masked", run.State, run.Error)
	}
	ev := r.events.last()
	if ev.Reason == nil || *ev.Reason != run.Error {
		t.Errorf("event reason = %v, want %q", ev.Reason, run.Error)
	}
	tail := strings.Join(ev.Tail, "\n")
	if strings.Contains(tail, secret) || !strings.Contains(tail, "postgres://app:"+redact.Mask+"@db") {
		t.Errorf("tail %q, want the env_file value masked", tail)
	}
}

func TestLineTail_KeepsLastLines(t *testing.T) {
	var many, last []string
	for i := range TailLines + 5 {
		many = append(many, fmt.Sprintf("line %d\n", i))
		if i >= 5 {
			last = append(last, fmt.Sprintf("line %d", i))
		}
	}
	tests := []struct {
		name   string
		writes []string
		want   []string
	}{
		{"empty", nil, []string{}},
		{"split writes", []string{"a", "b\nc", "\r\n"}, []string{"ab", "c"}},
		{"wraps, oldest first", many, last},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var lt lineTail
			for _, w := range tt.writes {
				if _, err := lt.Write([]byte(w)); err != nil {
					t.Fatal(err)
				}
			}
			if got := lt.lines(); !slices.Equal(got, tt.want) {
				t.Errorf("lines = %q, want %q", got, tt.want)
			}
		})
	}
}
