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

// deployment is the prod env of the test configuration.
func deployment(paths ...string) config.Deployment {
	return config.Deployment{
		On:       config.DeploymentOn{Push: "main"},
		Strategy: config.DeploymentStrategyComposeBluegreen,
		Paths:    paths,
	}
}

type fixture struct {
	in   *Intake
	st   *store.Store
	refs *fakeRefs
	n    int
}

func newFixture(t *testing.T, dep config.Deployment) *fixture {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	f := &fixture{st: st, refs: &fakeRefs{}}
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
		Strategy: "compose-bluegreen", Attempt: 1, State: store.DeployQueued, CreatedAt: t0, QueuedAt: t0,
	}
	if !run.CreatedAt.Equal(want.CreatedAt) || !run.QueuedAt.Equal(want.QueuedAt) {
		t.Errorf("CreatedAt, QueuedAt = %v, %v, want %v", run.CreatedAt, run.QueuedAt, want.CreatedAt)
	}
	run.CreatedAt, run.QueuedAt = want.CreatedAt, want.QueuedAt
	if run != want {
		t.Errorf("deploy run = %+v\nwant %+v", run, want)
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
			name:   "retry with no run for the commit",
			dep:    deployment(),
			mutate: func(tr *protocol.Trigger, _ *fakeRefs) { tr.Event = protocol.TriggerEventRetry },
			want:   "nothing to retry for prod at 0123456",
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
	if !errors.Is(err, boom) || got != (Decision{}) || IsPermanent(err) {
		t.Fatalf("Handle = %+v, %v; want zero decision and transient %v", got, err, boom)
	}
	if runs, _ := f.st.ListDeployRunsInStates(context.Background(), store.DeployQueued); len(runs) != 0 {
		t.Errorf("an error stored runs: %+v", runs)
	}
}

func TestIntake_NoEnvIsPermanent(t *testing.T) {
	f := newFixture(t, deployment())
	tr := pushTrigger()
	tr.Env = nil
	if _, err := f.in.Handle(context.Background(), tr); !IsPermanent(err) {
		t.Fatalf("Handle err = %v, want permanent", err)
	}
}

func TestIntake_RetryAttemptRules(t *testing.T) {
	type want struct {
		accepted bool
		reason   string
		retry    bool
		state    string // run state after Handle
		attempt  int
		retryOf  string
	}
	unchanged := func(state, reason string) want {
		return want{reason: reason, state: state, attempt: 1}
	}
	for _, tc := range []struct {
		name    string
		state   string // run-9 state at attempt 1
		attempt int    // trigger attempt
		mutate  func(*protocol.Trigger, *fakeRefs)
		want    want
	}{
		{name: "failed run retries", state: store.DeployFailed, attempt: 2,
			want: want{accepted: true, retry: true, state: store.DeployQueued, attempt: 2, retryOf: store.DeployFailed}},
		{name: "interrupted run retries", state: store.DeployInterrupted, attempt: 2,
			want: want{accepted: true, retry: true, state: store.DeployQueued, attempt: 2, retryOf: store.DeployInterrupted}},
		{name: "redelivered first trigger gets the run", state: store.DeployRunning, attempt: 1,
			want: want{accepted: true, state: store.DeployRunning, attempt: 1}},
		{name: "successful run", state: store.DeploySuccess, attempt: 2,
			want: unchanged(store.DeploySuccess, "nothing to retry for prod at 0123456 (attempt 2)")},
		{name: "running run", state: store.DeployRunning, attempt: 2,
			want: unchanged(store.DeployRunning, "nothing to retry for prod at 0123456 (attempt 2)")},
		{name: "attempt skips ahead", state: store.DeployFailed, attempt: 3,
			want: want{accepted: true, retry: true, state: store.DeployQueued, attempt: 2, retryOf: store.DeployFailed}},
		// zeroci retry on the host moved the agent's attempt past the hub's
		// count, so the hub's next retry carries the run's own attempt.
		{name: "failed run at the same attempt after a host retry", state: store.DeployFailed, attempt: 1,
			want: want{accepted: true, retry: true, state: store.DeployQueued, attempt: 2, retryOf: store.DeployFailed}},
		{name: "trigger behind the run", state: store.DeployFailed, attempt: 0,
			want: unchanged(store.DeployFailed, "nothing to retry for prod at 0123456 (attempt 0)")},
		{name: "branch no longer protected", state: store.DeployFailed, attempt: 2,
			mutate: func(_ *protocol.Trigger, r *fakeRefs) { r.unprotected = true },
			want: unchanged(store.DeployFailed,
				"deployments.prod: branch main is not protected on GitHub; protect it or remove the env")},
		{name: "sha no longer on branch", state: store.DeployFailed, attempt: 2,
			mutate: func(_ *protocol.Trigger, r *fakeRefs) { r.notOnRef = true },
			want:   unchanged(store.DeployFailed, "deployments.prod: 0123456 is not on main")},
		{name: "untrusted retry", state: store.DeployInterrupted, attempt: 2,
			mutate: func(tr *protocol.Trigger, _ *fakeRefs) { tr.Trust = protocol.TriggerTrustUntrusted },
			want:   unchanged(store.DeployInterrupted, "deployments.prod: untrusted trigger cannot deploy")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			// A paths filter no file matches: retries skip it.
			f := newFixture(t, deployment("services/api/**"))
			f.setLastSuccess(t, "prev-sha")
			f.refs.files = []string{"README.md"}
			f.in.LoadConfig = func(context.Context, string, string) (*config.Config, error) {
				t.Error("a retry loaded the configuration")
				return nil, errors.New("unexpected")
			}
			if err := f.st.InsertDeployRun(ctx, store.DeployRun{
				RunID: "run-9", Repo: "acme/web", Env: "prod", SHA: testSHA, Ref: "refs/heads/main",
				Strategy: "compose-bluegreen", Attempt: 1, State: tc.state, CreatedAt: t0,
			}); err != nil {
				t.Fatalf("InsertDeployRun: %v", err)
			}
			tr := pushTrigger()
			tr.Event, tr.Attempt = protocol.TriggerEventRetry, tc.attempt
			if tc.mutate != nil {
				tc.mutate(&tr, f.refs)
			}
			got, err := f.in.Handle(ctx, tr)
			if err != nil {
				t.Fatalf("Handle: %v", err)
			}
			wantDec := Decision{Reason: tc.want.reason}
			if tc.want.accepted {
				wantDec = Decision{Accepted: true, RunID: "run-9", Retry: tc.want.retry}
			}
			if got != wantDec {
				t.Errorf("Handle = %+v, want %+v", got, wantDec)
			}
			run, err := f.st.GetDeployRun(ctx, "run-9")
			if err != nil {
				t.Fatalf("GetDeployRun: %v", err)
			}
			if run.State != tc.want.state || run.Attempt != tc.want.attempt || run.RetryOfState != tc.want.retryOf {
				t.Errorf("run = %s attempt %d retry_of %q, want %s attempt %d retry_of %q",
					run.State, run.Attempt, run.RetryOfState, tc.want.state, tc.want.attempt, tc.want.retryOf)
			}
			if len(f.refs.compares) != 0 {
				t.Errorf("a retry compared %v for the paths filter", f.refs.compares)
			}
			if f.n != 0 {
				t.Errorf("a retry minted %d new run ids", f.n)
			}

			// A redelivery matches the run only at the attempt it re-queued;
			// the daemon drops any other repeat by trigger id.
			if !tc.want.retry || tc.attempt != tc.want.attempt {
				return
			}
			again, err := f.in.Handle(ctx, tr)
			if err != nil {
				t.Fatalf("redelivered Handle: %v", err)
			}
			if again != wantDec {
				t.Errorf("redelivered Handle = %+v, want %+v", again, wantDec)
			}
			if run, _ := f.st.GetDeployRun(ctx, "run-9"); run.Attempt != 2 {
				t.Errorf("redelivery moved the attempt to %d, want 2", run.Attempt)
			}
		})
	}
}
