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
// imageExists is set; docker compose down of project failDown fails; docker
// run fails with failRun when set; every command fails once ctx is done.
type recExecutor struct {
	mu          sync.Mutex
	calls       []execCall
	imageExists bool
	failDown    string
	failRun     error
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
	if e.failDown != "" && slices.Contains(argv, "down") && argv[3] == e.failDown {
		return fmt.Errorf("deploy: step finalize: exit status 1")
	}
	if e.failRun != nil && slices.Equal(argv[:2], []string{"docker", "run"}) {
		return e.failRun
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
// counts reloads. served is the route file content at the last reload that
// went through; onApply, when set, sees every applied content after the
// write.
type fakeProxy struct {
	mu      sync.Mutex
	applies []string
	reloads int
	file    string
	served  string
	onApply func(content string)
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
	p.applies = append(p.applies, string(content))
	p.file = file
	onApply := p.onApply
	p.mu.Unlock()
	if onApply != nil {
		onApply(string(content))
	}
	return prev, nil
}

func (p *fakeProxy) Reload(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reloads++
	if err := ctx.Err(); err != nil {
		return err
	}
	b, err := os.ReadFile(p.file)
	if err != nil {
		b = nil
	}
	p.served = string(b)
	return nil
}

func (p *fakeProxy) servedRoute() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.served
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
	chown    *fakeChown
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

	r := &bgRig{store: st, exec: &recExecutor{}, proxy: &fakeProxy{}, events: &events{}, stateDir: t.TempDir(), chown: &fakeChown{}}
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
		Access:   r.chown.access(),
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
		if f := strings.Fields(c); len(f) > 3 && f[1] == "compose" && slices.Contains(f, "down") {
			out = append(out, f[3])
		}
	}
	return out
}

func TestBlueGreen_Plan_StepNames(t *testing.T) {
	type np struct {
		name  string
		phase deploy.Phase
	}
	head := []np{{"build", deploy.PhaseApply}, {"prepare", deploy.PhaseApply}}
	tail := []np{
		{"migrate", deploy.PhaseApply}, {"start", deploy.PhaseApply}, {"health", deploy.PhaseApply},
		{"swap", deploy.PhaseApply}, {"verify", deploy.PhaseVerify}, {"finalize", deploy.PhaseVerify},
	}
	for _, tc := range []struct {
		name   string
		before *config.DeploymentMigrateBefore
		want   []np
	}{
		{"without migrate.before", nil, slices.Concat(head, tail)},
		{"with migrate.before", &config.DeploymentMigrateBefore{Run: "pg_dump", OutputDir: new("/var/backups/app")},
			slices.Concat(head, []np{{"migrate-before", deploy.PhaseApply}}, tail)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newBGRig(t)
			r.cfg.Migrate.Before = tc.before
			steps, err := r.strat.Plan(store.DeployRun{Repo: bgRepo, Env: bgEnv, SHA: bgSHA}, r.cfg)
			if err != nil {
				t.Fatalf("Plan: %v", err)
			}
			var got []np
			for _, s := range steps {
				got = append(got, np{s.Name, s.Phase})
			}
			if !slices.Equal(got, tc.want) {
				t.Fatalf("plan = %v, want %v", got, tc.want)
			}
		})
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
	wantHandedOver(t, r.chown, r.stateDir, overridePath, nil)
	wantMode(t, filepath.Join(r.stateDir, "deploy", bgRepo, bgEnv, "active-color"), 0o644)
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
	wantDown := "docker compose -p myapp-blue -f " + filepath.Join(r.strat.WorkDir(store.DeployRun{}), "compose.yml") +
		" -f " + filepath.Join(r.stateDir, "deploy", bgRepo, bgEnv, "blue.override.yml") + " down --remove-orphans"
	if last := cmds[len(cmds)-1]; last != wantDown {
		t.Fatalf("last command = %q, want the finalize down %q", last, wantDown)
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

func TestBlueGreen_MigrateBeforeFailure_OldColorServes(t *testing.T) {
	r := newBGRig(t)
	wantSuccess(t, r.deploy(t))
	r.exec.reset()
	appliesBefore := len(r.proxy.applied())
	routeBefore := r.routeFile(t)
	r.cfg.Migrate.Before = &config.DeploymentMigrateBefore{
		Run: "pg_dump -Fc -f /backup/{env}-{sha7}-{ts}.dump", OutputDir: new(filepath.Join(t.TempDir(), "backups")),
	}
	r.exec.failRun = fmt.Errorf("deploy: step migrate-before: exit code 1")

	run := r.deploy(t)
	if run.State != store.DeployFailed || !strings.Contains(run.Error, "migrate-before: exit code 1") {
		t.Fatalf("state = %s (%s), want Failed with the hook error", run.State, run.Error)
	}
	steps, err := r.store.ListSteps(context.Background(), run.RunID)
	if err != nil {
		t.Fatal(err)
	}
	last := steps[len(steps)-1]
	if last.Name != "migrate-before" || last.Status != store.StepFailed {
		t.Fatalf("last step = %s %s, want migrate-before failed", last.Name, last.Status)
	}
	cmds := r.exec.commands()
	for _, c := range cmds {
		if strings.Contains(c, " run --rm web ") || strings.Contains(c, " up -d") {
			t.Fatalf("command %q ran after the hook failed; commands:\n%s", c, strings.Join(cmds, "\n"))
		}
	}
	if !slices.ContainsFunc(cmds, func(c string) bool { return strings.HasPrefix(c, "docker run --rm ") }) {
		t.Fatalf("no hook container in %v", cmds)
	}
	if got := downs(cmds); !slices.Equal(got, []string{"myapp-green"}) {
		t.Fatalf("down projects = %v, want only the idle myapp-green", got)
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
	if got := r.activeColor(t); got != "blue" {
		t.Fatalf("active_color = %q, want unchanged blue", got)
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
	if !strings.Contains(run.Error, "deployments.production.verify: 503 at 15s of 30s") {
		t.Fatalf("error = %q, want the verify failure at the 3rd interval", run.Error)
	}
	if strings.Contains(run.Error, "previous color restored") {
		t.Fatalf("error = %q claims the restore the verify step did not do", run.Error)
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

func TestBlueGreen_FirstDeployVerifyFailure_EmptiesRoute(t *testing.T) {
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
	if got, want := r.routeFile(t), "# zerocideploy: no active route for "+bgRepo+" production\n"; got != want {
		t.Fatalf("route = %q, want the empty route %q", got, want)
	}
	if got := r.proxy.servedRoute(); got != r.routeFile(t) {
		t.Fatalf("proxy serves %q, want the empty route", got)
	}
	if r.proxy.reloads != 2 {
		t.Fatalf("reloads = %d, want 2 (swap and empty route)", r.proxy.reloads)
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

// A crash after the swap wrote the route file but before the reload left the
// proxy on the old color; the resumed swap must reload even though the file
// already holds the new route.
func TestBlueGreen_ResumeAfterCrashBeforeSwapReload_Reloads(t *testing.T) {
	r := newBGRig(t)
	wantSuccess(t, r.deploy(t))
	blue := fmt.Sprintf("blue %d\n", store.DefaultPortLo)
	green := fmt.Sprintf("green %d\n", store.DefaultPortLo+1)

	id := r.newRun(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.proxy.onApply = func(content string) {
		if content == green {
			cancel()
		}
	}
	if err := r.engine.Start(ctx, id); err == nil {
		t.Fatal("Start survived a crash between the route write and the reload")
	}
	r.proxy.onApply = nil
	if got := r.routeFile(t); got != green {
		t.Fatalf("route file after crash = %q, want %q", got, green)
	}
	if got := r.proxy.servedRoute(); got != blue {
		t.Fatalf("proxy after crash serves %q, want the old %q", got, blue)
	}
	if err := r.store.SetDeployRunState(context.Background(), id, store.DeployInterrupted, "agent restarted", bgT0); err != nil {
		t.Fatal(err)
	}

	if err := r.engine.Resume(context.Background(), id); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	wantSuccess(t, r.run(t, id))
	if got := r.proxy.servedRoute(); got != green {
		t.Fatalf("proxy serves %q, want the new %q", got, green)
	}
}

// A crash during the rollback's route restore, after the write and before
// the reload, left the proxy on the failed color; the rollback a retry
// finishes must reload even though the file already holds the old route.
func TestBlueGreen_RetryAfterCrashBeforeRestoreReload_Reloads(t *testing.T) {
	r := newBGRig(t)
	wantSuccess(t, r.deploy(t))
	blue := fmt.Sprintf("blue %d\n", store.DefaultPortLo)
	green := fmt.Sprintf("green %d\n", store.DefaultPortLo+1)
	base := r.requests.Load()
	r.status = func(n int64) int {
		if n-base == 2 {
			return http.StatusServiceUnavailable
		}
		return http.StatusOK
	}

	id := r.newRun(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.proxy.onApply = func(content string) {
		if content == blue {
			cancel()
		}
	}
	if err := r.engine.Start(ctx, id); err == nil {
		t.Fatal("Start survived a crash during the route restore")
	}
	r.proxy.onApply = nil
	if got := r.routeFile(t); got != blue {
		t.Fatalf("route file after crash = %q, want %q", got, blue)
	}
	if got := r.proxy.servedRoute(); got != green {
		t.Fatalf("proxy after crash serves %q, want the failed %q", got, green)
	}
	bg := context.Background()
	if err := r.store.SetDeployRunState(bg, id, store.DeployInterrupted, "agent restarted", bgT0); err != nil {
		t.Fatal(err)
	}
	if err := r.store.MarkRetryRequested(bg, id, store.DeployInterrupted); err != nil {
		t.Fatal(err)
	}
	// The deploy the retry starts after the rollback fails its health gate,
	// before any swap, so the route stays where the rollback left it.
	r.status = func(int64) int { return http.StatusBadGateway }

	if err := r.engine.Retry(bg, id); err != nil {
		t.Fatalf("Retry: %v", err)
	}
	if got := r.proxy.servedRoute(); got != blue {
		t.Fatalf("proxy serves %q, want the restored %q", got, blue)
	}
}

// Once finalize wrote the marker the deploy is committed: a failed stop of
// the previous color must not roll the live color back.
func TestBlueGreen_FinalizeDownFailure_KeepsCommittedColor(t *testing.T) {
	r := newBGRig(t)
	wantSuccess(t, r.deploy(t))
	r.exec.reset()
	r.exec.failDown = "myapp-blue"
	green := fmt.Sprintf("green %d\n", store.DefaultPortLo+1)

	wantSuccess(t, r.deploy(t))
	if got := r.marker(t); got != "green" {
		t.Fatalf("marker = %q, want green", got)
	}
	if got := r.routeFile(t); got != green {
		t.Fatalf("route = %q, want %q", got, green)
	}
	if got := r.proxy.servedRoute(); got != green {
		t.Fatalf("proxy serves %q, want %q", got, green)
	}
	if got := downs(r.exec.commands()); !slices.Equal(got, []string{"myapp-blue"}) {
		t.Fatalf("down projects = %v, want only the failed stop of myapp-blue", got)
	}
}

// A rollback of a step whose outputs name the color the marker already
// holds, as the rollback a retry finishes after a failed finalize, must not
// revert the committed color.
func TestBlueGreen_RollbackOfCommittedColor_DoesNothing(t *testing.T) {
	r := newBGRig(t)
	wantSuccess(t, r.deploy(t))
	run := r.deploy(t)
	wantSuccess(t, run)
	steps, err := r.store.ListSteps(context.Background(), run.RunID)
	if err != nil {
		t.Fatal(err)
	}
	finalize := steps[len(steps)-1]
	r.exec.reset()
	appliesBefore := len(r.proxy.applied())
	var log strings.Builder

	sc := &deploy.StepContext{Run: run, Cfg: r.cfg, Outputs: finalize.Outputs, Exec: r.exec, Log: &log, Clock: clock.NewFake(bgT0)}
	if err := r.strat.Rollback(context.Background(), sc, finalize.Index); err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if got := r.proxy.applied()[appliesBefore:]; len(got) != 0 {
		t.Fatalf("proxy applies = %q, want none", got)
	}
	if got := r.exec.commands(); len(got) != 0 {
		t.Fatalf("commands = %q, want none", got)
	}
	if !strings.Contains(log.String(), "nothing to roll back") {
		t.Fatalf("log = %q, want why nothing was rolled back", log.String())
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
