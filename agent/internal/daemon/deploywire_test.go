package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/agentconf"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/source"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// deploySource checks out files, or fails with err, and records requests.
type deploySource struct {
	files map[string]string
	err   error
	mu    sync.Mutex
	reqs  []source.Request
}

func (s *deploySource) Name() string { return "fake" }

func (s *deploySource) Checkout(_ context.Context, req source.Request, dir string) (source.Checkout, error) {
	s.mu.Lock()
	s.reqs = append(s.reqs, req)
	s.mu.Unlock()
	if s.err != nil {
		return source.Checkout{}, s.err
	}
	if err := writeTree(dir, s.files); err != nil {
		return source.Checkout{}, err
	}
	return source.Checkout{Repo: req.Repo, Dir: dir, SHA: req.SHA, Ref: req.Ref, Release: func() {}}, nil
}

func (s *deploySource) requests() []source.Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.reqs)
}

// wire is a daemon with the real deploy lane: the default intake and config
// loader against a fake GitHub, deploy units and the proxy reload on a fake
// runner, health probes against a fake app, and every token request answered
// as the hub would.
type wire struct {
	*harness
	stateDir string
	src      *deploySource
	runner   *execx.Fake
	mu       sync.Mutex
	units    []string // systemd-run argv of every deploy unit
}

const wireConfig = `version: 1
deployments:
  prod:
    on: { push: main }
    strategy: compose-bluegreen
    compose: { project: app, file: compose.yml, service: web }
    route: { kind: caddy, file: %s }
    health: { url: "http://127.0.0.1:{port}/health", retries: 100, interval: 10ms }
    verify: { window: 30ms, interval: 10ms }
`

// newWire starts the daemon after seed has filled the store.
func newWire(t *testing.T, src *deploySource, seed func(*store.Store)) *wire {
	t.Helper()
	stateDir := t.TempDir()
	st, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	seed(st)

	cfg := fmt.Sprintf(wireConfig, filepath.Join(t.TempDir(), "app-prod.caddy"))
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ghs_hub" {
			http.Error(w, "bad credentials", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/repos/acme/app/contents/.zeroci.yml":
			_, _ = w.Write([]byte(cfg))
		case "/repos/acme/app/branches/main":
			_, _ = w.Write([]byte(`{"protected":true}`))
		case "/repos/acme/app/compare/main..." + headSHA:
			_, _ = w.Write([]byte(`{"status":"identical"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(gh.Close)
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(app.Close)
	// Every color's port reaches the fake app.
	probe := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, app.Listener.Addr().String())
	}}}

	me, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	w := &wire{stateDir: stateDir, src: src, runner: &execx.Fake{}}
	w.runner.On("systemd-run", nil, execx.FakeResponse{Fn: func(c execx.Cmd) error {
		w.mu.Lock()
		w.units = append(w.units, strings.Join(c.Args, " "))
		w.mu.Unlock()
		return nil
	}})
	w.runner.On("caddy", []string{"reload"}, execx.FakeResponse{})

	conf := &agentconf.AgentConfig{HubURL: "https://hub.invalid", AgentID: "agt_1", Credential: "zc_agent_x"}
	dialer := &idleDialer{dialed: make(chan struct{})}
	d := New(conf, st, nil, Options{
		StateDir: stateDir, Dialer: dialer, Source: src,
		DeployRunner: w.runner, DeployUser: me.Username, HealthClient: probe,
	})
	intake := d.deploys.(*hubIntake)
	intake.githubURL, intake.http = gh.URL, gh.Client()
	load := githubDeployment(gh.URL, gh.Client(), d.tokens.Request)
	d.deploySched.LoadDeployment = load
	d.deploySched.Engine.LoadDeployment = load

	ctx, cancel := context.WithCancel(context.Background())
	w.harness = &harness{t: t, ctx: ctx, st: st, d: d}
	done := make(chan error, 1)
	go func() { done <- d.Run(ctx) }()
	answered := make(chan struct{})
	go func() {
		defer close(answered)
		answerTokens(ctx, st, d)
	}()
	t.Cleanup(func() {
		cancel()
		<-answered
		if err := <-done; err != context.Canceled {
			t.Errorf("Run = %v, want context.Canceled", err)
		}
	})
	<-dialer.dialed
	return w
}

// answerTokens answers every token_request in the outbox with a hub token
// until ctx ends.
func answerTokens(ctx context.Context, st *store.Store, d *Daemon) {
	exp := int(time.Now().Add(time.Hour).Unix())
	for ctx.Err() == nil {
		items, _ := st.Pending(ctx, 0, 0)
		for _, it := range items {
			if it.Kind != "token_request" {
				continue
			}
			var req protocol.TokenRequest
			if json.Unmarshal(it.Payload, &req) == nil {
				_ = d.HandleFrame(ctx, protocol.Token{RunId: req.RunId, Token: "ghs_hub", Exp: exp})
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// waitDeploy waits until run id reaches a finished state and returns it.
func (w *wire) waitDeploy(id string) store.DeployRun {
	w.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		run, err := w.st.GetDeployRun(w.ctx, id)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			w.t.Fatal(err)
		}
		if run.State == store.DeploySuccess || run.State == store.DeployFailed {
			return run
		}
		time.Sleep(5 * time.Millisecond)
	}
	w.t.Fatalf("deploy run %s never finished", id)
	return store.DeployRun{}
}

func (w *wire) unitCalls() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.units)
}

// accept sends a trusted push trigger for env prod and returns its run.
func (w *wire) accept(id string) store.DeployRun {
	w.t.Helper()
	w.send(w.deployTrigger(id, "prod"))
	w.waitTrigger(id, store.TriggerDone)
	run, err := w.st.FindDeployRun(w.ctx, "acme/app", "prod", headSHA, 1)
	if err != nil {
		w.t.Fatal(err)
	}
	return run
}

// TestDeployWiredEndToEnd: an accepted push deploys with compose-bluegreen
// from a checkout in deploy-work, in deploy units as the deploy user.
func TestDeployWiredEndToEnd(t *testing.T) {
	src := &deploySource{files: map[string]string{"compose.yml": "services:\n  web:\n    build: .\n    expose: [\"8080\"]\n"}}
	w := newWire(t, src, func(*store.Store) {})
	run := w.waitDeploy(w.accept("trg_push").RunID)
	if run.State != store.DeploySuccess {
		t.Fatalf("run = %s %q, want %s", run.State, run.Error, store.DeploySuccess)
	}

	workDir := filepath.Join(w.stateDir, "deploy-work", run.RunID)
	if _, err := os.Stat(filepath.Join(workDir, "compose.yml")); err != nil {
		t.Errorf("checkout: %v", err)
	}
	if _, err := os.Stat(workDir + ".partial"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("partial checkout left behind: %v", err)
	}
	// A resumed run reuses the finished checkout.
	if err := w.d.checkoutDeploy(w.ctx, run); err != nil {
		t.Errorf("second checkout: %v", err)
	}
	me, _ := user.Current()
	reqs := src.requests()
	if len(reqs) != 1 || reqs[0].RunID != run.RunID || reqs[0].SHA != headSHA || reqs[0].Repo != "acme/app" ||
		reqs[0].RunAs == nil || fmt.Sprint(reqs[0].RunAs.Uid) != me.Uid {
		t.Errorf("checkout requests = %+v, want one for %s at %s as uid %s", reqs, run.RunID, headSHA, me.Uid)
	}

	units := w.unitCalls()
	if len(units) == 0 {
		t.Fatal("no deploy unit ran")
	}
	unitArgs := "--unit=" + deploy.UnitName(run.RunID) + " --uid=" + deploy.DeployUser + " --gid=" + deploy.DeployUser + " "
	for _, u := range units {
		if !strings.HasPrefix(u, unitArgs) {
			t.Errorf("unit %q, want prefix %q", u, unitArgs)
		}
	}
	if !slices.ContainsFunc(units, func(u string) bool {
		return strings.HasSuffix(u, "--working-directory="+workDir+" -- docker image inspect app:"+headSHA[:7])
	}) {
		t.Errorf("units = %q, want the image check in %s", units, workDir)
	}
	if !w.runner.Called("caddy", "reload") {
		t.Error("proxy never reloaded")
	}
	var runTokens int
	for _, f := range w.frames("token_request") {
		if f["run_id"] == run.RunID {
			runTokens++
		}
	}
	if runTokens == 0 {
		t.Errorf("token requests = %v, want the config fetched with a token for %s", w.frames("token_request"), run.RunID)
	}
}

// TestDeployWiredUntrustedRun: a queued run no intake accepted fails before
// its checkout.
func TestDeployWiredUntrustedRun(t *testing.T) {
	src := &deploySource{files: map[string]string{"compose.yml": "services: {}\n"}}
	w := newWire(t, src, func(st *store.Store) {
		if err := st.InsertDeployRun(context.Background(), store.DeployRun{
			RunID: "run_bare", Repo: "acme/app", Env: "prod", SHA: headSHA, Ref: "refs/heads/main",
			Strategy: "compose-bluegreen", State: store.DeployQueued,
		}); err != nil {
			t.Fatal(err)
		}
	})
	run := w.waitDeploy("run_bare")
	if want := "deployments.prod: executor: " + deploy.ErrUntrustedDeploy.Error(); run.State != store.DeployFailed || run.Error != want {
		t.Errorf("run = %s %q, want %s %q", run.State, run.Error, store.DeployFailed, want)
	}
	if reqs := src.requests(); len(reqs) != 0 {
		t.Errorf("checkout requests = %+v, want none", reqs)
	}
	if units := w.unitCalls(); len(units) != 0 {
		t.Errorf("units = %q, want none", units)
	}
}

// TestDeployWiredCheckoutFailure: a failed fetch fails the run with the
// step and the cause, and leaves no checkout.
func TestDeployWiredCheckoutFailure(t *testing.T) {
	src := &deploySource{err: errors.New("source: fetch acme/app: repository not found")}
	w := newWire(t, src, func(*store.Store) {})
	run := w.waitDeploy(w.accept("trg_push").RunID)
	want := "deployments.prod: checkout acme/app@" + headSHA[:7] + ": daemon: deploy checkout: source: fetch acme/app: repository not found"
	if run.State != store.DeployFailed || run.Error != want {
		t.Errorf("run = %s %q, want %s %q", run.State, run.Error, store.DeployFailed, want)
	}
	workDir := filepath.Join(w.stateDir, "deploy-work", run.RunID)
	for _, dir := range []string{workDir, workDir + ".partial"} {
		if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s: %v, want no checkout", dir, err)
		}
	}
	if units := w.unitCalls(); len(units) != 0 {
		t.Errorf("units = %q, want none", units)
	}
}
