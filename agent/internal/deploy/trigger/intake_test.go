package trigger

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

var t0 = time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)

const testSHA = "0123456789abcdef0123456789abcdef01234567"

// fakeRefs answers RefChecker calls from fields and records the compares.
type fakeRefs struct {
	mu          sync.Mutex
	unprotected bool
	notOnRef    bool
	files       []string
	truncated   bool
	err         error // returned by every call
	compares    [][2]string
}

func (f *fakeRefs) IsProtected(context.Context, string, string) (bool, error) {
	return !f.unprotected, f.err
}

func (f *fakeRefs) ContainsSHA(context.Context, string, string, string) (bool, error) {
	return !f.notOnRef, f.err
}

func (f *fakeRefs) ChangedFiles(_ context.Context, _, base, head string) ([]string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.compares = append(f.compares, [2]string{base, head})
	return f.files, f.truncated, f.err
}

type fakeSched struct {
	mu   sync.Mutex
	runs []string
}

func (f *fakeSched) Enqueue(_ context.Context, runID string, retry bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if retry {
		runID += "+retry"
	}
	f.runs = append(f.runs, runID)
}

func (f *fakeSched) enqueued() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.runs...)
}

// deployment is the prod env of the test configuration.
func deployment(paths ...string) config.Deployment {
	return config.Deployment{
		On:       config.DeploymentOn{Push: "main"},
		Strategy: config.DeploymentStrategyComposeBluegreen,
		Paths:    paths,
	}
}

type fixture struct {
	in    *Intake
	st    *store.Store
	refs  *fakeRefs
	sched *fakeSched
	n     int
}

func newFixture(t *testing.T, dep config.Deployment) *fixture {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	f := &fixture{st: st, refs: &fakeRefs{}, sched: &fakeSched{}}
	cfg := &config.Config{ZeroCIConfig: config.ZeroCIConfig{
		Deployments: config.ZeroCIConfigDeployments{"prod": dep},
	}}
	f.in = &Intake{
		Store: st,
		Refs:  f.refs,
		LoadConfig: func(_ context.Context, repo, sha string) (*config.Config, error) {
			if repo != "acme/web" || sha != testSHA {
				t.Errorf("LoadConfig(%s, %s), want acme/web at the trigger sha", repo, sha)
			}
			return cfg, nil
		},
		Clock: func() time.Time { return t0 },
		NewRunID: func() string {
			f.n++
			return "run-" + string(rune('0'+f.n))
		},
		Sched: f.sched,
	}
	return f
}

func pushTrigger() protocol.Trigger {
	env := "prod"
	return protocol.Trigger{
		Type: "trigger", V: 1, TriggerId: "trg-1", Repo: "acme/web", Ref: "refs/heads/main", Sha: testSHA,
		Event: protocol.TriggerEventPush, Trust: protocol.TriggerTrustTrusted, Env: &env, Attempt: 1,
	}
}

func TestIntake_AcceptsProtectedPushOnRef(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t, deployment())
	got, err := f.in.Handle(ctx, pushTrigger())
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if !got.Accepted || got.RunID != "run-1" || got.Reason != "" {
		t.Fatalf("Handle = %+v, want accepted run-1", got)
	}
	run, err := f.st.GetDeployRun(ctx, "run-1")
	if err != nil {
		t.Fatalf("GetDeployRun: %v", err)
	}
	want := store.DeployRun{
		RunID: "run-1", Repo: "acme/web", Env: "prod", SHA: testSHA, Ref: "refs/heads/main",
		Strategy: "compose-bluegreen", Attempt: 1, State: store.DeployQueued, CreatedAt: t0,
	}
	if !run.CreatedAt.Equal(want.CreatedAt) {
		t.Errorf("CreatedAt = %v, want %v", run.CreatedAt, want.CreatedAt)
	}
	run.CreatedAt = want.CreatedAt
	if run != want {
		t.Errorf("deploy run = %+v\nwant %+v", run, want)
	}
	if got := f.sched.enqueued(); len(got) != 1 || got[0] != "run-1" {
		t.Errorf("enqueued = %v, want [run-1]", got)
	}
}

func TestIntake_NilSchedulerStillAccepts(t *testing.T) {
	f := newFixture(t, deployment())
	f.in.Sched = nil
	got, err := f.in.Handle(context.Background(), pushTrigger())
	if err != nil || !got.Accepted {
		t.Fatalf("Handle = %+v, %v; want accepted", got, err)
	}
}

func TestIntake_RedeliveryIsIdempotent(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t, deployment())
	first, err := f.in.Handle(ctx, pushTrigger())
	if err != nil || !first.Accepted {
		t.Fatalf("first Handle = %+v, %v", first, err)
	}
	// A redelivery, even under a new trigger id, answers with the same run
	// and does not look at GitHub again.
	f.refs.unprotected = true
	again := pushTrigger()
	again.TriggerId = "trg-2"
	second, err := f.in.Handle(ctx, again)
	if err != nil || second != first {
		t.Fatalf("second Handle = %+v, %v; want %+v", second, err, first)
	}
	if got := f.sched.enqueued(); len(got) != 1 {
		t.Errorf("enqueued = %v, want one run", got)
	}
	runs, err := f.st.ListDeployRunsInStates(ctx, store.DeployQueued)
	if err != nil || len(runs) != 1 {
		t.Errorf("queued runs = %+v, %v; want one", runs, err)
	}

	// A new attempt of the same sha is a new run.
	next := pushTrigger()
	next.Attempt = 2
	third, err := f.in.Handle(ctx, next)
	if err != nil {
		t.Fatalf("attempt 2 Handle: %v", err)
	}
	if !strings.Contains(third.Reason, "not protected") {
		t.Errorf("attempt 2 = %+v, want a fresh check (rejected as unprotected)", third)
	}
}

func TestIntake_Rejections(t *testing.T) {
	for _, tc := range []struct {
		name        string
		dep         config.Deployment
		lastSuccess string
		mutate      func(*protocol.Trigger, *fakeRefs)
		want        string
	}{
		{
			name:   "pull request event",
			dep:    deployment(),
			mutate: func(tr *protocol.Trigger, _ *fakeRefs) { tr.Event = protocol.TriggerEventPullRequest },
			want:   "deploys run only from push or retry, got pull_request",
		},
		{
			name: "env not in config",
			dep:  deployment(),
			mutate: func(tr *protocol.Trigger, _ *fakeRefs) {
				env := "staging"
				tr.Env = &env
			},
			want: "deployments.staging: env not defined in .zeroci.yml at 0123456",
		},
		{
			name:   "branch not listed",
			dep:    deployment(),
			mutate: func(tr *protocol.Trigger, _ *fakeRefs) { tr.Ref = "refs/heads/feature/x" },
			want:   "deployments.prod.on.push: branch feature/x is not listed",
		},
		{
			name:   "branch not protected",
			dep:    deployment(),
			mutate: func(_ *protocol.Trigger, r *fakeRefs) { r.unprotected = true },
			want:   "deployments.prod: branch main is not protected on GitHub; protect it or remove the env",
		},
		{
			name:   "sha not on branch",
			dep:    deployment(),
			mutate: func(_ *protocol.Trigger, r *fakeRefs) { r.notOnRef = true },
			want:   "deployments.prod: 0123456 is not on main",
		},
		{
			name:        "no changed file matches paths",
			dep:         deployment("services/api/**"),
			lastSuccess: "prev-sha",
			mutate: func(_ *protocol.Trigger, r *fakeRefs) {
				r.files = []string{"services/web/app.ts", "README.md"}
			},
			want: "deployments.prod.paths: no changed file matches",
		},
		{
			name:   "untrusted trigger",
			dep:    deployment(),
			mutate: func(tr *protocol.Trigger, _ *fakeRefs) { tr.Trust = protocol.TriggerTrustUntrusted },
			want:   "deployments.prod: untrusted trigger cannot deploy",
		},
		{
			name:   "retry stub",
			dep:    deployment(),
			mutate: func(tr *protocol.Trigger, _ *fakeRefs) { tr.Event = protocol.TriggerEventRetry },
			want:   "retry not supported yet",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			f := newFixture(t, tc.dep)
			tr := pushTrigger()
			if tc.lastSuccess != "" {
				f.setLastSuccess(t, tc.lastSuccess)
			}
			tc.mutate(&tr, f.refs)
			got, err := f.in.Handle(ctx, tr)
			if err != nil {
				t.Fatalf("Handle: %v", err)
			}
			if got.Accepted || got.RunID != "" || got.Reason != tc.want {
				t.Fatalf("Handle = %+v\nwant rejected %q", got, tc.want)
			}
			if runs, _ := f.st.ListDeployRunsInStates(ctx, store.DeployQueued); len(runs) != 0 {
				t.Errorf("a rejection stored runs: %+v", runs)
			}
			if got := f.sched.enqueued(); len(got) != 0 {
				t.Errorf("a rejection enqueued %v", got)
			}
		})
	}
}

func (f *fixture) setLastSuccess(t *testing.T, sha string) {
	t.Helper()
	if err := f.st.SetDeployState(context.Background(), store.DeployState{
		Repo: "acme/web", Env: "prod", ActiveColor: "blue", LastSuccessSHA: sha, LastSuccessRun: "old",
	}); err != nil {
		t.Fatalf("SetDeployState: %v", err)
	}
}

func TestIntake_PathsNoLastSuccessDeploys(t *testing.T) {
	f := newFixture(t, deployment("services/api/**"))
	f.refs.files = []string{"README.md"}
	got, err := f.in.Handle(context.Background(), pushTrigger())
	if err != nil || !got.Accepted {
		t.Fatalf("Handle = %+v, %v; want accepted", got, err)
	}
	if len(f.refs.compares) != 0 {
		t.Errorf("compared %v with no last success", f.refs.compares)
	}
}

func TestIntake_PathsTruncatedDeploys(t *testing.T) {
	f := newFixture(t, deployment("services/api/**"))
	f.setLastSuccess(t, "prev-sha")
	f.refs.files, f.refs.truncated = []string{"README.md"}, true
	got, err := f.in.Handle(context.Background(), pushTrigger())
	if err != nil || !got.Accepted {
		t.Fatalf("Handle = %+v, %v; want accepted", got, err)
	}
	if len(f.refs.compares) != 1 || f.refs.compares[0] != [2]string{"prev-sha", testSHA} {
		t.Errorf("compares = %v, want prev-sha...%s", f.refs.compares, testSHA)
	}
}

func TestIntake_PathsMatchDeploys(t *testing.T) {
	f := newFixture(t, deployment("services/api/**"))
	f.setLastSuccess(t, "prev-sha")
	f.refs.files = []string{"README.md", "services/api/main.go"}
	got, err := f.in.Handle(context.Background(), pushTrigger())
	if err != nil || !got.Accepted {
		t.Fatalf("Handle = %+v, %v; want accepted", got, err)
	}
}

func TestIntake_GitHubErrorIsAnError(t *testing.T) {
	f := newFixture(t, deployment())
	boom := errors.New("github /repos/acme/web/branches/main: 502")
	f.refs.err = boom
	got, err := f.in.Handle(context.Background(), pushTrigger())
	if !errors.Is(err, boom) || got != (Decision{}) {
		t.Fatalf("Handle = %+v, %v; want zero decision and %v", got, err, boom)
	}
	if runs, _ := f.st.ListDeployRunsInStates(context.Background(), store.DeployQueued); len(runs) != 0 {
		t.Errorf("an error stored runs: %+v", runs)
	}
}
