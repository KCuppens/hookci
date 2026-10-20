package deploy

import (
	"context"
	"fmt"
	"maps"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

var t0 = time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)

// stepTime is how long every fake step takes on the fake clock.
const stepTime = 2 * time.Second

type fakeStep struct {
	name  string
	phase Phase
}

// fourSteps is a plan of two apply and two verify steps.
var fourSteps = []fakeStep{
	{"build", PhaseApply}, {"start", PhaseApply}, {"verify", PhaseVerify}, {"finalize", PhaseVerify},
}

type stepCall struct {
	index   int
	outputs map[string]string // sc.Outputs when the step started
}

// fakeStrategy runs fake steps. Step i sets output key <name> to out<i>,
// unless hook or failAt makes it fail first.
type fakeStrategy struct {
	clock       *clock.Fake
	steps       []fakeStep
	failAt      map[int]error
	hook        func(ctx context.Context, sc *StepContext, i int) error
	planErr     error
	rollbackErr error

	mu        sync.Mutex
	ran       []stepCall
	rollbacks []int
}

func (f *fakeStrategy) Name() string { return "fake" }

func (f *fakeStrategy) Plan(store.DeployRun, config.Deployment) ([]Step, error) {
	if f.planErr != nil {
		return nil, f.planErr
	}
	steps := make([]Step, len(f.steps))
	for i, s := range f.steps {
		steps[i] = Step{Name: s.name, Phase: s.phase, Run: func(ctx context.Context, sc *StepContext) error {
			return f.runStep(ctx, sc, i)
		}}
	}
	return steps, nil
}

func (f *fakeStrategy) runStep(ctx context.Context, sc *StepContext, i int) error {
	f.mu.Lock()
	f.ran = append(f.ran, stepCall{index: i, outputs: maps.Clone(sc.Outputs)})
	f.mu.Unlock()
	f.clock.Advance(stepTime)
	if f.hook != nil {
		if err := f.hook(ctx, sc, i); err != nil {
			return err
		}
	}
	if err := f.failAt[i]; err != nil {
		return err
	}
	sc.Outputs[f.steps[i].name] = fmt.Sprintf("out%d", i)
	return nil
}

func (f *fakeStrategy) Rollback(_ context.Context, _ *StepContext, failedIndex int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rollbacks = append(f.rollbacks, failedIndex)
	return f.rollbackErr
}

func (f *fakeStrategy) ranIndexes() []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]int, len(f.ran))
	for i, c := range f.ran {
		out[i] = c.index
	}
	return out
}

// fakeEvents collects the frames the engine emits.
type fakeEvents struct {
	mu      sync.Mutex
	planned []protocol.JobPlanned
	events  []protocol.Event
}

func (f *fakeEvents) DeployPlanned(p protocol.JobPlanned) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.planned = append(f.planned, p)
}

func (f *fakeEvents) DeployEvent(ev protocol.Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, ev)
}

// states returns the event states with repeats collapsed.
func (f *fakeEvents) states() []protocol.EventState {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []protocol.EventState
	for _, ev := range f.events {
		if len(out) == 0 || out[len(out)-1] != ev.State {
			out = append(out, ev.State)
		}
	}
	return out
}

func (f *fakeEvents) last() protocol.Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.events[len(f.events)-1]
}

// fakeExecutor records the commands it is asked to run.
type fakeExecutor struct {
	mu    sync.Mutex
	names []string
}

func (f *fakeExecutor) Run(_ context.Context, name string, _ []string, _ ExecOpts) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.names = append(f.names, name)
	return nil
}

type testRig struct {
	engine *Engine
	store  *store.Store
	strat  *fakeStrategy
	events *fakeEvents
	clock  *clock.Fake
}

// newRig opens a store in a temp dir and inserts run r1 for production in
// state. The strategy plans steps.
func newRig(t *testing.T, state string, steps []fakeStep) *testRig {
	t.Helper()
	clk := clock.NewFake(t0)
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"), store.WithClock(clk.Now))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.InsertDeployRun(context.Background(), store.DeployRun{
		RunID: "r1", Repo: "acme/web", Env: "production", SHA: "abc123", Ref: "refs/heads/main",
		Strategy: "fake", State: state, CreatedAt: t0,
	}); err != nil {
		t.Fatalf("InsertDeployRun: %v", err)
	}
	strat := &fakeStrategy{clock: clk, steps: steps}
	events := &fakeEvents{}
	return &testRig{
		engine: &Engine{
			Store:      st,
			Strategies: map[string]DeployStrategy{strat.Name(): strat},
			Events:     events,
			Clock:      clk,
			NewExecutor: func(context.Context, store.DeployRun, config.Deployment) (Executor, error) {
				return &fakeExecutor{}, nil
			},
			Checkout: func(context.Context, store.DeployRun) error { return nil },
			LoadDeployment: func(context.Context, store.DeployRun) (config.Deployment, error) {
				return config.Deployment{Strategy: "compose-inplace"}, nil
			},
		},
		store: st, strat: strat, events: events, clock: clk,
	}
}

func (r *testRig) run(t *testing.T) store.DeployRun {
	t.Helper()
	run, err := r.store.GetDeployRun(context.Background(), "r1")
	if err != nil {
		t.Fatalf("GetDeployRun: %v", err)
	}
	return run
}

func (r *testRig) steps(t *testing.T) []store.DeployStep {
	t.Helper()
	steps, err := r.store.ListSteps(context.Background(), "r1")
	if err != nil {
		t.Fatalf("ListSteps: %v", err)
	}
	return steps
}
