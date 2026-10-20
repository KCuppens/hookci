package compose

import (
	"context"
	"fmt"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/health"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

var bgT0 = time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)

const (
	bgRepo = "acme/web"
	bgEnv  = "production"
	bgSHA  = "abcdef1234567890"
)

// autoClock is a fake clock whose After fires at once, moving time forward
// by d, so health retries and the verify window run without sleeping.
type autoClock struct{ *clock.Fake }

func (c autoClock) After(d time.Duration) <-chan time.Time {
	ch := c.Fake.After(d)
	c.Advance(d)
	return ch
}

type execCall struct {
	argv []string
	opts deploy.ExecOpts
}

// recExecutor records commands. docker image inspect succeeds only when
// imageExists is set; every command fails once ctx is done.
type recExecutor struct {
	mu          sync.Mutex
	calls       []execCall
	imageExists bool
}

func (e *recExecutor) Run(ctx context.Context, _ string, argv []string, opts deploy.ExecOpts) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, execCall{argv: slices.Clone(argv), opts: opts})
	if slices.Equal(argv[:3], []string{"docker", "image", "inspect"}) && !e.imageExists {
		return fmt.Errorf("deploy: step build: exit status 1")
	}
	return nil
}

func (e *recExecutor) commands() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for _, c := range e.calls {
		out = append(out, strings.Join(c.argv, " "))
	}
	return out
}

func (e *recExecutor) reset() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = nil
}

// fakeProxy renders "<color> <port>", writes the route file for real and
// counts reloads.
type fakeProxy struct {
	mu      sync.Mutex
	applies []string
	reloads int
}

func (p *fakeProxy) Render(r proxy.RouteSpec) ([]byte, error) {
	return fmt.Appendf(nil, "%s %d\n", r.Color, r.Port), nil
}

func (p *fakeProxy) Apply(ctx context.Context, file string, content []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	prev, err := os.ReadFile(file)
	if err != nil {
		prev = nil
	}
	if err := os.WriteFile(file, content, 0o644); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.applies = append(p.applies, string(content))
	return prev, nil
}

func (p *fakeProxy) Reload(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reloads++
	return ctx.Err()
}

func (p *fakeProxy) applied() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.applies)
}

// events calls onStep with the step index of every step event.
type events struct{ onStep func(i int) }

func (events) DeployPlanned(protocol.JobPlanned) {}

func (e events) DeployEvent(ev protocol.Event) {
	if ev.StepIndex != nil && e.onStep != nil {
		e.onStep(*ev.StepIndex)
	}
}

type bgRig struct {
	store    *store.Store
	engine   *deploy.Engine
	strat    *BlueGreen
	exec     *recExecutor
	proxy    *fakeProxy
	events   *events
	cfg      config.Deployment
	stateDir string
	route    string
	// status returns the app's health status for the n-th request (from 1).
	status   func(n int64) int
	requests atomic.Int64
	runs     int
}

func newBGRig(t *testing.T) *bgRig {
	t.Helper()
	clk := autoClock{clock.NewFake(bgT0)}
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"), store.WithClock(clk.Now))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	r := &bgRig{store: st, exec: &recExecutor{}, proxy: &fakeProxy{}, events: &events{}, stateDir: t.TempDir()}
	r.status = func(int64) int { return http.StatusOK }
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(r.status(r.requests.Add(1)))
	}))
	t.Cleanup(app.Close)

	workdir := t.TempDir()
	compose := "services:\n  web:\n    build: .\n    ports:\n      - \"8080\"\n"
	if err := os.WriteFile(filepath.Join(workdir, "compose.yml"), []byte(compose), 0o644); err != nil {
		t.Fatal(err)
	}
	r.route = filepath.Join(t.TempDir(), "production.caddy")
	r.cfg = config.Deployment{
		Strategy: "compose-bluegreen",
		Compose:  &config.DeploymentCompose{Project: "myapp", File: "compose.yml", Service: "web"},
		Migrate:  &config.DeploymentMigrate{Run: "./migrate up"},
		Route:    &config.DeploymentRoute{Kind: config.DeploymentRouteKindCaddy, File: r.route},
		Health:   &config.DeploymentHealth{Url: app.URL + "/healthz?port={port}", Retries: 3, Interval: "1s"},
		Verify:   &config.DeploymentVerify{Window: "30s", Interval: "5s"},
	}
	r.strat = &BlueGreen{
		Store:    st,
		Proxy:    func(config.DeploymentRoute) (proxy.ProxyAdapter, error) { return r.proxy, nil },
		Health:   &health.Checker{Clock: clk},
		StateDir: r.stateDir,
		WorkDir:  func(store.DeployRun) string { return workdir },
	}
	r.engine = &deploy.Engine{
		Store:      st,
		Strategies: map[string]deploy.DeployStrategy{r.strat.Name(): r.strat},
		Events:     r.events,
		Clock:      clk,
		NewExecutor: func(context.Context, store.DeployRun, config.Deployment) (deploy.Executor, error) {
			return r.exec, nil
		},
		Checkout: func(context.Context, store.DeployRun) error { return nil },
		LoadDeployment: func(context.Context, store.DeployRun) (config.Deployment, error) {
			return r.cfg, nil
		},
	}
	return r
}

// newRun inserts a queued run and returns its id.
func (r *bgRig) newRun(t *testing.T) string {
	t.Helper()
	r.runs++
	id := "r" + strconv.Itoa(r.runs)
	if err := r.store.InsertDeployRun(context.Background(), store.DeployRun{
		RunID: id, Repo: bgRepo, Env: bgEnv, SHA: bgSHA, Ref: "refs/heads/main",
		Strategy: "compose-bluegreen", State: store.DeployQueued, CreatedAt: bgT0,
	}); err != nil {
		t.Fatalf("InsertDeployRun: %v", err)
	}
	return id
}

// deploy runs a new deploy to its end and returns the run.
func (r *bgRig) deploy(t *testing.T) store.DeployRun {
	t.Helper()
	id := r.newRun(t)
	if err := r.engine.Start(context.Background(), id); err != nil {
		t.Fatalf("Start(%s): %v", id, err)
	}
	return r.run(t, id)
}

func (r *bgRig) run(t *testing.T, id string) store.DeployRun {
	t.Helper()
	run, err := r.store.GetDeployRun(context.Background(), id)
	if err != nil {
		t.Fatalf("GetDeployRun: %v", err)
	}
	return run
}

func (r *bgRig) marker(t *testing.T) string {
	t.Helper()
	got, err := ReadMarker(filepath.Join(r.stateDir, "deploy", bgRepo, bgEnv, "active-color"))
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func (r *bgRig) activeColor(t *testing.T) string {
	t.Helper()
	st, ok, err := r.store.GetDeployState(context.Background(), bgRepo, bgEnv)
	if err != nil || !ok {
		t.Fatalf("GetDeployState = %v, %v", ok, err)
	}
	return st.ActiveColor
}

func (r *bgRig) routeFile(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(r.route)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func wantSuccess(t *testing.T, run store.DeployRun) {
	t.Helper()
	if run.State != store.DeploySuccess {
		t.Fatalf("run %s state = %s (%s), want Success", run.RunID, run.State, run.Error)
	}
}

// downs returns the projects brought down, in order.
func downs(cmds []string) []string {
	var out []string
	for _, c := range cmds {
		if f := strings.Fields(c); len(f) == 5 && f[1] == "compose" && f[4] == "down" {
			out = append(out, f[3])
		}
	}
	return out
}

func TestBlueGreen_Plan_StepNames(t *testing.T) {
	r := newBGRig(t)
	steps, err := r.strat.Plan(store.DeployRun{Repo: bgRepo, Env: bgEnv, SHA: bgSHA}, r.cfg)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	type np struct {
		name  string
		phase deploy.Phase
	}
	want := []np{
		{"build", deploy.PhaseApply}, {"prepare", deploy.PhaseApply}, {"migrate", deploy.PhaseApply},
		{"start", deploy.PhaseApply}, {"health", deploy.PhaseApply}, {"swap", deploy.PhaseApply},
		{"verify", deploy.PhaseVerify}, {"finalize", deploy.PhaseVerify},
	}
	var got []np
	for _, s := range steps {
		got = append(got, np{s.Name, s.Phase})
	}
	if !slices.Equal(got, want) {
		t.Fatalf("plan = %v, want %v", got, want)
	}
}

func TestBlueGreen_HappyPath_FirstDeploy(t *testing.T) {
	r := newBGRig(t)
	run := r.deploy(t)
	wantSuccess(t, run)

	port, err := r.store.AllocatePort(context.Background(), bgRepo, bgEnv, "blue", store.DefaultPortLo, store.DefaultPortHi)
	if err != nil || port != store.DefaultPortLo {
		t.Fatalf("blue port = %d, %v; want %d", port, err, store.DefaultPortLo)
	}
	overridePath := filepath.Join(r.stateDir, "deploy", bgRepo, bgEnv, "blue.override.yml")
	override, err := os.ReadFile(overridePath)
	if err != nil {
		t.Fatalf("override: %v", err)
	}
	if want := fmt.Sprintf("127.0.0.1:%d:8080", port); !strings.Contains(string(override), want) ||
		!strings.Contains(string(override), "myapp:abcdef1") {
		t.Fatalf("override = %s, want port %s and image myapp:abcdef1", override, want)
	}
	if got, want := r.routeFile(t), fmt.Sprintf("blue %d\n", port); got != want {
		t.Fatalf("route = %q, want %q", got, want)
	}
	if got := r.marker(t); got != "blue" {
		t.Fatalf("marker = %q, want blue", got)
	}
	if got := r.activeColor(t); got != "blue" {
		t.Fatalf("active_color = %q, want blue", got)
	}

	compose := filepath.Join(r.strat.WorkDir(run), "compose.yml")
	wantCmds := []string{
		"docker image inspect myapp:abcdef1",
		"docker build -t myapp:abcdef1 -f Dockerfile .",
		"docker compose -p myapp-blue -f " + compose + " -f " + overridePath + " run --rm web sh -c ./migrate up",
		"docker compose -p myapp-blue -f " + compose + " -f " + overridePath + " up -d --remove-orphans",
	}
	if got := r.exec.commands(); !slices.Equal(got, wantCmds) {
		t.Fatalf("commands =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(wantCmds, "\n"))
	}
	build := r.exec.calls[1].opts
	if build.Env["DOCKER_BUILDKIT"] != "1" || build.Dir != r.strat.WorkDir(run) {
		t.Fatalf("build opts = %+v, want DOCKER_BUILDKIT=1 in the build context", build)
	}
}

func TestBlueGreen_HappyPath_Alternates(t *testing.T) {
	r := newBGRig(t)
	wantSuccess(t, r.deploy(t))
	r.exec.reset()

	wantSuccess(t, r.deploy(t))
	if got := r.marker(t); got != "green" {
		t.Fatalf("marker = %q, want green", got)
	}
	if got := r.activeColor(t); got != "green" {
		t.Fatalf("active_color = %q, want green", got)
	}
	if got, want := r.routeFile(t), fmt.Sprintf("green %d\n", store.DefaultPortLo+1); got != want {
		t.Fatalf("route = %q, want %q", got, want)
	}
	cmds := r.exec.commands()
	if !slices.Contains(cmds, "docker compose -p myapp-green -f "+filepath.Join(r.strat.WorkDir(store.DeployRun{}), "compose.yml")+
		" -f "+filepath.Join(r.stateDir, "deploy", bgRepo, bgEnv, "green.override.yml")+" up -d --remove-orphans") {
		t.Fatalf("no up for myapp-green in %v", cmds)
	}
	if got := downs(cmds); !slices.Equal(got, []string{"myapp-blue"}) {
		t.Fatalf("down projects = %v, want [myapp-blue] in finalize", got)
	}
	if last := cmds[len(cmds)-1]; last != "docker compose -p myapp-blue down" {
		t.Fatalf("last command = %q, want the finalize down of myapp-blue", last)
	}

	r.exec.reset()
	wantSuccess(t, r.deploy(t))
	if got := r.marker(t); got != "blue" {
		t.Fatalf("third deploy marker = %q, want blue", got)
	}
	if got := downs(r.exec.commands()); !slices.Equal(got, []string{"myapp-green"}) {
		t.Fatalf("third deploy down projects = %v, want [myapp-green]", got)
	}
}

func TestBlueGreen_HealthFailure_BeforeSwap(t *testing.T) {
	r := newBGRig(t)
	wantSuccess(t, r.deploy(t))
	r.exec.reset()
	appliesBefore := len(r.proxy.applied())
	routeBefore := r.routeFile(t)
	r.status = func(int64) int { return http.StatusBadGateway }

	run := r.deploy(t)
	if run.State != store.DeployFailed {
		t.Fatalf("state = %s, want Failed", run.State)
	}
	if !strings.Contains(run.Error, "deployments.production.health: 502 after 3 tries") {
		t.Fatalf("error = %q, want the health error", run.Error)
	}
	if got := downs(r.exec.commands()); !slices.Equal(got, []string{"myapp-green"}) {
		t.Fatalf("down projects = %v, want only the target myapp-green", got)
	}
	if got := len(r.proxy.applied()); got != appliesBefore {
		t.Fatalf("proxy Apply called %d times during the failed deploy, want 0", got-appliesBefore)
	}
	if got := r.routeFile(t); got != routeBefore {
		t.Fatalf("route = %q, want unchanged %q", got, routeBefore)
	}
	if got := r.marker(t); got != "blue" {
		t.Fatalf("marker = %q, want unchanged blue", got)
	}
}

func TestBlueGreen_VerifyFailure_AfterSwap(t *testing.T) {
	r := newBGRig(t)
	wantSuccess(t, r.deploy(t))
	r.exec.reset()
	reloadsBefore := r.proxy.reloads
	appliesBefore := len(r.proxy.applied())
	// Request 1 of the deploy is the health gate; 2 to 4 are the verify
	// probes at 5s, 10s and 15s.
	base := r.requests.Load()
	r.status = func(n int64) int {
		if n-base == 4 {
			return http.StatusServiceUnavailable
		}
		return http.StatusOK
	}

	run := r.deploy(t)
	if run.State != store.DeployFailed {
		t.Fatalf("state = %s, want Failed", run.State)
	}
	if !strings.Contains(run.Error, "deployments.production.verify: 503 at 15s of 30s; previous color restored") {
		t.Fatalf("error = %q, want the verify failure at the 3rd interval", run.Error)
	}
	applies := r.proxy.applied()[appliesBefore:]
	want := []string{
		fmt.Sprintf("green %d\n", store.DefaultPortLo+1),
		fmt.Sprintf("blue %d\n", store.DefaultPortLo),
	}
	if !slices.Equal(applies, want) {
		t.Fatalf("proxy applies = %q, want %q", applies, want)
	}
	if got := r.proxy.reloads - reloadsBefore; got != 2 {
		t.Fatalf("reloads = %d, want 2 (swap and restore)", got)
	}
	if got := r.routeFile(t); got != want[1] {
		t.Fatalf("route = %q, want the previous color %q", got, want[1])
	}
	if got := downs(r.exec.commands()); !slices.Equal(got, []string{"myapp-green"}) {
		t.Fatalf("down projects = %v, want only the target myapp-green", got)
	}
	if got := r.marker(t); got != "blue" {
		t.Fatalf("marker = %q, want unchanged blue", got)
	}
}

func TestBlueGreen_FirstDeployVerifyFailure_RemovesRoute(t *testing.T) {
	r := newBGRig(t)
	r.status = func(n int64) int {
		if n == 2 {
			return http.StatusInternalServerError
		}
		return http.StatusOK
	}
	run := r.deploy(t)
	if run.State != store.DeployFailed {
		t.Fatalf("state = %s, want Failed", run.State)
	}
	if _, err := os.Stat(r.route); !os.IsNotExist(err) {
		t.Fatalf("route file stat err = %v, want removed", err)
	}
	if r.proxy.reloads != 2 {
		t.Fatalf("reloads = %d, want 2 (swap and removal)", r.proxy.reloads)
	}
	if got := downs(r.exec.commands()); !slices.Equal(got, []string{"myapp-blue"}) {
		t.Fatalf("down projects = %v, want [myapp-blue]", got)
	}
	if got := r.marker(t); got != "" {
		t.Fatalf("marker = %q, want none", got)
	}
}

func TestBlueGreen_ResumeAfterEachStep(t *testing.T) {
	for k := 1; k <= 8; k++ {
		t.Run(strconv.Itoa(k), func(t *testing.T) {
			r := newBGRig(t)
			wantSuccess(t, r.deploy(t))
			r.exec.reset()

			id := r.newRun(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r.events.onStep = func(i int) {
				if i == k-1 {
					cancel()
				}
			}
			if err := r.engine.Start(ctx, id); err == nil {
				t.Fatalf("Start survived a crash at step %d", k)
			}
			r.events.onStep = nil
			if got := r.marker(t); k < 8 && got != "blue" {
				t.Fatalf("marker after crash at step %d = %q, want blue", k, got)
			}
			if err := r.store.SetDeployRunState(context.Background(), id, store.DeployInterrupted, "agent restarted", bgT0); err != nil {
				t.Fatal(err)
			}

			if err := r.engine.Resume(context.Background(), id); err != nil {
				t.Fatalf("Resume: %v", err)
			}
			wantSuccess(t, r.run(t, id))
			if got := r.marker(t); got != "green" {
				t.Fatalf("marker = %q, want green", got)
			}
			if got := r.activeColor(t); got != "green" {
				t.Fatalf("active_color = %q, want green", got)
			}
			if got, want := r.routeFile(t), fmt.Sprintf("green %d\n", store.DefaultPortLo+1); got != want {
				t.Fatalf("route = %q, want %q", got, want)
			}
			steps, err := r.store.ListSteps(context.Background(), id)
			if err != nil {
				t.Fatal(err)
			}
			for _, s := range steps[1:] {
				if c := s.Outputs["color"]; c != "green" {
					t.Fatalf("step %s outputs color %q, want green", s.Name, c)
				}
			}
			for _, p := range downs(r.exec.commands()) {
				if p != "myapp-blue" {
					t.Fatalf("down of %s, want only the old color myapp-blue", p)
				}
			}
		})
	}
}

func TestBlueGreen_BuildSkipsExistingImage(t *testing.T) {
	r := newBGRig(t)
	r.exec.imageExists = true
	wantSuccess(t, r.deploy(t))
	for _, c := range r.exec.commands() {
		if strings.HasPrefix(c, "docker build") {
			t.Fatalf("issued %q although the image exists", c)
		}
	}
	if got := r.exec.commands()[0]; got != "docker image inspect myapp:abcdef1" {
		t.Fatalf("first command = %q, want the image inspect", got)
	}
}

func TestNoDirectExec(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(fset, f, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range parsed.Imports {
			if imp.Path.Value == `"os/exec"` {
				t.Errorf("%s imports os/exec; run commands through deploy.Executor", f)
			}
		}
	}
}
