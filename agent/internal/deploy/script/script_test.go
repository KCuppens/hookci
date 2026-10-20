package script

import (
	"context"
	"errors"
	"io"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

var t0 = time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)

type execCall struct {
	name string
	argv []string
	opts deploy.ExecOpts
}

// fakeExec writes output to the run command's stdout in 7-byte chunks, so
// lines span writes, then fails it when runErr is set.
type fakeExec struct {
	mu          sync.Mutex
	calls       []execCall
	output      string
	runErr      error
	rollbackErr error
}

func (e *fakeExec) Run(_ context.Context, name string, argv []string, opts deploy.ExecOpts) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, execCall{name: name, argv: slices.Clone(argv), opts: opts})
	switch name {
	case "run":
		for out := e.output; out != ""; {
			n := min(7, len(out))
			if _, err := io.WriteString(opts.Stdout, out[:n]); err != nil {
				return err
			}
			out = out[n:]
		}
		return e.runErr
	case "rollback":
		return e.rollbackErr
	}
	return nil
}

type eventLog struct {
	mu     sync.Mutex
	events []protocol.Event
}

func (*eventLog) DeployPlanned(protocol.JobPlanned) {}

func (l *eventLog) DeployEvent(ev protocol.Event) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, ev)
}

// progress returns the sub-step events: a step without steps_total.
func (l *eventLog) progress() []protocol.Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []protocol.Event
	for _, ev := range l.events {
		if ev.Step != nil && ev.StepsTotal == nil {
			out = append(out, ev)
		}
	}
	return out
}

type rig struct {
	store   *store.Store
	engine  *deploy.Engine
	exec    *fakeExec
	events  *eventLog
	cfg     config.Deployment
	workdir string
}

func newRig(t *testing.T, run string) *rig {
	t.Helper()
	clk := clock.NewFake(t0)
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"), store.WithClock(clk.Now))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	r := &rig{store: st, exec: &fakeExec{}, events: &eventLog{}, workdir: t.TempDir()}
	r.cfg = config.Deployment{Strategy: config.DeploymentStrategyScript, Run: &run}
	strat := &Script{WorkDir: func(store.DeployRun) string { return r.workdir }, Clock: clk}
	r.engine = &deploy.Engine{
		Store:       st,
		Strategies:  map[string]deploy.DeployStrategy{strat.Name(): strat},
		Events:      r.events,
		Clock:       clk,
		NewExecutor: func(store.DeployRun) deploy.Executor { return r.exec },
		LoadDeployment: func(context.Context, store.DeployRun) (config.Deployment, error) {
			return r.cfg, nil
		},
	}
	return r
}

func (r *rig) deploy(t *testing.T) store.DeployRun {
	t.Helper()
	ctx := context.Background()
	if err := r.store.InsertDeployRun(ctx, store.DeployRun{
		RunID: "r1", Repo: "acme/web", Env: "production", SHA: "abcdef1234567890", Ref: "refs/heads/main",
		Strategy: "script", State: store.DeployQueued, CreatedAt: t0,
	}); err != nil {
		t.Fatalf("InsertDeployRun: %v", err)
	}
	if err := r.engine.Start(ctx, "r1"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	run, err := r.store.GetDeployRun(ctx, "r1")
	if err != nil {
		t.Fatalf("GetDeployRun: %v", err)
	}
	return run
}

func TestParseStepMarker(t *testing.T) {
	tests := []struct {
		line, name string
		ok         bool
	}{
		{"::zeroci step migrate", "migrate", true},
		{"::zeroci step db.migrate_v2-up", "db.migrate_v2-up", true},
		{"::zeroci step 0", "0", true},
		{"::zeroci step  restart \r", "restart", true},
		{"::zeroci step " + strings.Repeat("a", 40), strings.Repeat("a", 40), true},
		{"::zeroci step ", "", false},
		{"::zeroci step", "", false},
		{"::zeroci step    ", "", false},
		{"::zeroci step Migrate", "", false},
		{"::zeroci step " + strings.Repeat("a", 41), "", false},
		{"::zeroci step two words", "", false},
		{"::zeroci step -lead", "", false},
		{"echo ::zeroci step migrate", "", false},
		{" ::zeroci step migrate", "", false},
		{"::zeroci  step migrate", "", false},
		{"building", "", false},
	}
	for _, tt := range tests {
		name, ok := ParseStepMarker(tt.line)
		if name != tt.name || ok != tt.ok {
			t.Errorf("ParseStepMarker(%q) = %q, %v; want %q, %v", tt.line, name, ok, tt.name, tt.ok)
		}
	}
}

func TestScript_Plan(t *testing.T) {
	s := &Script{}
	run := store.DeployRun{Env: "production"}
	cmd := "./deploy.sh"
	steps, err := s.Plan(run, config.Deployment{Run: &cmd})
	if err != nil || len(steps) != 1 || steps[0].Name != "run" || steps[0].Phase != deploy.PhaseApply {
		t.Fatalf("Plan = %+v, %v; want the single apply step run", steps, err)
	}
	empty := ""
	for _, cfg := range []config.Deployment{{}, {Run: &empty}} {
		if _, err := s.Plan(run, cfg); err == nil || !strings.HasPrefix(err.Error(), "deployments.production.run: required") {
			t.Errorf("Plan(%+v) error = %v, want run required", cfg, err)
		}
	}
}

func TestScript_ProgressEvents(t *testing.T) {
	r := newRig(t, "./deploy.sh")
	r.exec.output = "::zeroci step build\nbuilding\necho ::zeroci step nope\n::zeroci step BAD\n" +
		"::zeroci step " + strings.Repeat("x", maxMarkerLine) + "\n::zeroci step migrate\n::zeroci step restart"
	run := r.deploy(t)
	if run.State != store.DeploySuccess {
		t.Fatalf("state = %s (%s), want Success", run.State, run.Error)
	}
	var names []string
	var indexes []int
	for _, ev := range r.events.progress() {
		names = append(names, *ev.Step)
		indexes = append(indexes, *ev.StepIndex)
		if ev.Job == nil || *ev.Job != deploy.JobName || ev.RunId != "r1" {
			t.Errorf("progress event %+v lacks the run or job", ev)
		}
	}
	if want := []string{"build", "migrate", "restart"}; !slices.Equal(names, want) {
		t.Errorf("progress steps = %v, want %v", names, want)
	}
	if want := []int{1, 2, 3}; !slices.Equal(indexes, want) {
		t.Errorf("progress step_index = %v, want %v", indexes, want)
	}
	if len(r.exec.calls) != 1 {
		t.Fatalf("calls = %+v, want only run", r.exec.calls)
	}
	c := r.exec.calls[0]
	if c.name != "run" || !slices.Equal(c.argv, []string{"sh", "-c", "./deploy.sh"}) || c.opts.Dir != r.workdir {
		t.Errorf("run call = %s %v in %s, want run sh -c ./deploy.sh in %s", c.name, c.argv, c.opts.Dir, r.workdir)
	}
}

func TestScript_RollbackRunsWithFailedStep(t *testing.T) {
	r := newRig(t, "./deploy.sh")
	rollback := "./rollback.sh"
	r.cfg.Rollback = &rollback
	r.exec.output = "::zeroci step build\n::zeroci step migrate\nmigration 0042 failed\n"
	r.exec.runErr = errors.New("deploy: step run: exit code 1")
	run := r.deploy(t)
	if run.State != store.DeployFailed {
		t.Fatalf("state = %s, want Failed", run.State)
	}
	if len(r.exec.calls) != 2 {
		t.Fatalf("calls = %+v, want run then rollback", r.exec.calls)
	}
	c := r.exec.calls[1]
	if c.name != "rollback" || !slices.Equal(c.argv, []string{"sh", "-c", "./rollback.sh"}) || c.opts.Dir != r.workdir {
		t.Errorf("rollback call = %s %v in %s, want rollback sh -c ./rollback.sh in %s", c.name, c.argv, c.opts.Dir, r.workdir)
	}
	if want := map[string]string{"ZEROCI_FAILED_STEP": "migrate"}; !maps.Equal(c.opts.Env, want) {
		t.Errorf("rollback env = %v, want %v", c.opts.Env, want)
	}
}

func TestScript_RollbackFailureKeepsFailed(t *testing.T) {
	r := newRig(t, "./deploy.sh")
	rollback := "./rollback.sh"
	r.cfg.Rollback = &rollback
	r.exec.runErr = errors.New("deploy: step run: exit code 1")
	r.exec.rollbackErr = errors.New("deploy: step rollback: exit code 2")
	run := r.deploy(t)
	if run.State != store.DeployFailed {
		t.Fatalf("state = %s, want Failed", run.State)
	}
	if want := "rollback failed: deployments.production.rollback: deploy: step rollback: exit code 2"; !strings.Contains(run.Error, want) {
		t.Errorf("error = %q, want it to contain %q", run.Error, want)
	}
	if env := r.exec.calls[1].opts.Env; env["ZEROCI_FAILED_STEP"] != "" {
		t.Errorf("rollback env = %v, want an empty failed step when the script reported none", env)
	}
}

func TestScript_NoRollbackConfigured(t *testing.T) {
	r := newRig(t, "./deploy.sh")
	r.exec.output = "::zeroci step migrate\n"
	r.exec.runErr = errors.New("deploy: step run: exit code 1")
	run := r.deploy(t)
	if run.State != store.DeployFailed {
		t.Fatalf("state = %s, want Failed", run.State)
	}
	if len(r.exec.calls) != 1 || r.exec.calls[0].name != "run" {
		t.Errorf("calls = %+v, want only run", r.exec.calls)
	}
}
