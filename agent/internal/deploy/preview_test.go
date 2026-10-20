package deploy_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/strategies"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy/caddy"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

const (
	pvRepo = "acme/web"
	pvEnv  = "staging"
	pvSHA  = "0123456789abcdef0123456789abcdef01234567"
)

// countingExecutor records every command a step would run.
type countingExecutor struct {
	mu    sync.Mutex
	calls [][]string
}

func (e *countingExecutor) Run(_ context.Context, _ string, argv []string, _ deploy.ExecOpts) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, argv)
	return nil
}

// previewRig is a real store, the real strategies and a caddy adapter whose
// runner records commands, all under one temp dir.
type previewRig struct {
	root, stateDir, dbPath, route string
	store                         *store.Store
	proxy                         *caddy.Adapter
	runner                        *execx.Fake
	exec                          *countingExecutor
	engine                        *deploy.Engine
	reads                         []string
}

func newPreviewRig(t *testing.T) *previewRig {
	t.Helper()
	r := &previewRig{root: t.TempDir(), runner: &execx.Fake{}, exec: &countingExecutor{}}
	r.stateDir = filepath.Join(r.root, "state")
	workDir := filepath.Join(r.root, "work")
	r.route = filepath.Join(r.root, "caddy", "staging.caddy")
	for _, dir := range []string{r.stateDir, workDir, filepath.Dir(r.route)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	compose := "services:\n  web:\n    build: .\n    ports:\n      - \"8080\"\n"
	if err := os.WriteFile(filepath.Join(workDir, "compose.yml"), []byte(compose), 0o644); err != nil {
		t.Fatal(err)
	}
	r.dbPath = filepath.Join(r.stateDir, "agent.db")
	st, err := store.Open(r.dbPath)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	r.store = st
	if r.proxy, err = caddy.New(r.runner, ""); err != nil {
		t.Fatalf("caddy.New: %v", err)
	}
	r.engine = &deploy.Engine{
		Store: st,
		Strategies: strategies.New(strategies.Deps{
			Store: st, Proxy: r.proxy, StateDir: r.stateDir,
			WorkDir: func(store.DeployRun) string { return workDir },
		}),
		NewExecutor: func(store.DeployRun) deploy.Executor { return r.exec },
	}
	return r
}

func (r *previewRig) blueGreen() config.Deployment {
	return config.Deployment{
		Strategy: config.DeploymentStrategyComposeBluegreen,
		Compose:  &config.DeploymentCompose{Project: "web", File: "compose.yml", Service: "web"},
		Migrate:  &config.DeploymentMigrate{Run: "./migrate up"},
		Route:    &config.DeploymentRoute{Kind: config.DeploymentRouteKindCaddy, File: r.route, UpstreamHost: "127.0.0.1"},
		Health:   &config.DeploymentHealth{Url: "http://127.0.0.1:{port}/healthz", Retries: 3, Interval: "1s"},
		Verify:   &config.DeploymentVerify{Window: "30s", Interval: "5s"},
	}
}

// readFile is os.ReadFile recording each path.
func (r *previewRig) readFile(path string) ([]byte, error) {
	r.reads = append(r.reads, path)
	return os.ReadFile(path)
}

func (r *previewRig) preview(t *testing.T, cfg config.Deployment) deploy.PlanPreview {
	t.Helper()
	pv, err := deploy.BuildPreview(context.Background(), r.engine, deploy.PreviewContext{
		Repo: pvRepo, Env: pvEnv, SHA: pvSHA, Cfg: cfg, Store: r.store, ReadFile: r.readFile,
	})
	if err != nil {
		t.Fatalf("BuildPreview: %v", err)
	}
	return pv
}

// activateBlue makes blue the serving color on its allocated port, the way
// a finished blue deploy leaves the host.
func (r *previewRig) activateBlue(t *testing.T, cfg config.Deployment) int {
	t.Helper()
	ctx := context.Background()
	port, err := r.store.AllocatePort(ctx, pvRepo, pvEnv, "blue", store.DefaultPortLo, store.DefaultPortHi)
	if err != nil {
		t.Fatalf("AllocatePort: %v", err)
	}
	marker := filepath.Join(r.stateDir, "deploy", pvRepo, pvEnv, "active-color")
	if err := os.MkdirAll(filepath.Dir(marker), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte("blue\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	route, err := r.proxy.Render(proxy.RouteSpec{Repo: pvRepo, Env: pvEnv, Color: "blue", UpstreamHost: "127.0.0.1", Port: port})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if err := os.WriteFile(cfg.Route.File, route, 0o644); err != nil {
		t.Fatal(err)
	}
	return port
}

func TestPreview_BlueGreen(t *testing.T) {
	r := newPreviewRig(t)
	cfg := r.blueGreen()
	bluePort := r.activateBlue(t, cfg)

	pv := r.preview(t, cfg)

	wantSteps := []string{"build", "prepare", "migrate", "start", "health", "swap", "verify", "finalize"}
	if !slices.Equal(pv.Steps, wantSteps) {
		t.Errorf("Steps = %v, want %v", pv.Steps, wantSteps)
	}
	if pv.Repo != pvRepo || pv.Env != pvEnv || pv.Strategy != "compose-bluegreen" {
		t.Errorf("Repo, Env, Strategy = %q, %q, %q", pv.Repo, pv.Env, pv.Strategy)
	}
	if pv.ActiveColor != "blue" || pv.TargetColor != "green" {
		t.Errorf("colors = %q -> %q, want blue -> green", pv.ActiveColor, pv.TargetColor)
	}
	if pv.TargetPort != bluePort+1 {
		t.Errorf("TargetPort = %d, want %d", pv.TargetPort, bluePort+1)
	}
	if pv.Image != "web:0123456" {
		t.Errorf("Image = %q, want web:0123456", pv.Image)
	}
	if !strings.Contains(pv.Override, "web:0123456") || !strings.Contains(pv.Override, "20001") {
		t.Errorf("Override does not pin image and port:\n%s", pv.Override)
	}
	for _, want := range []string{
		"--- " + r.route,
		"-reverse_proxy 127.0.0.1:20000",
		"+reverse_proxy 127.0.0.1:20001",
		"+# managed by zeroci: acme/web staging color=green. Do not edit.",
	} {
		if !strings.Contains(pv.RouteDiff, want) {
			t.Errorf("RouteDiff lacks %q:\n%s", want, pv.RouteDiff)
		}
	}
}

func TestPreview_UsesAllocatedTargetPort(t *testing.T) {
	r := newPreviewRig(t)
	cfg := r.blueGreen()
	r.activateBlue(t, cfg)
	ctx := context.Background()
	// A port of another repo sits between, so the next free port differs
	// from green's own allocation.
	green, err := r.store.AllocatePort(ctx, pvRepo, pvEnv, "green", store.DefaultPortLo, store.DefaultPortHi)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.store.AllocatePort(ctx, "acme/other", pvEnv, "blue", store.DefaultPortLo, store.DefaultPortHi); err != nil {
		t.Fatal(err)
	}

	if pv := r.preview(t, cfg); pv.TargetPort != green {
		t.Errorf("TargetPort = %d, want green's allocation %d", pv.TargetPort, green)
	}
}

func TestPreview_NoSideEffects(t *testing.T) {
	r := newPreviewRig(t)
	cfg := r.blueGreen()
	r.activateBlue(t, cfg)
	rowsBefore := countPortAllocations(t, r.dbPath)
	treeBefore := snapshotTree(t, r.root)

	r.preview(t, cfg)

	if len(r.exec.calls) != 0 {
		t.Errorf("executor ran %v", r.exec.calls)
	}
	if len(r.runner.Calls) != 0 {
		t.Errorf("proxy ran %v", r.runner.Calls)
	}
	if got := countPortAllocations(t, r.dbPath); got != rowsBefore {
		t.Errorf("port_allocations rows = %d, want %d", got, rowsBefore)
	}
	treeAfter := snapshotTree(t, r.root)
	for path, content := range treeAfter {
		if before, ok := treeBefore[path]; !ok || before != content {
			t.Errorf("preview wrote %s", path)
		}
	}
	for path := range treeBefore {
		if _, ok := treeAfter[path]; !ok {
			t.Errorf("preview removed %s", path)
		}
	}
	marker := filepath.Join(r.stateDir, "deploy", pvRepo, pvEnv, "active-color")
	if !slices.Contains(r.reads, marker) || !slices.Contains(r.reads, r.route) {
		t.Errorf("reads = %v, want the marker and route file through ReadFile", r.reads)
	}
}

func TestPreview_FirstDeploy(t *testing.T) {
	r := newPreviewRig(t)

	pv := r.preview(t, r.blueGreen())

	if pv.ActiveColor != "" || pv.TargetColor != "blue" {
		t.Errorf("colors = %q -> %q, want none -> blue", pv.ActiveColor, pv.TargetColor)
	}
	if pv.TargetPort != store.DefaultPortLo {
		t.Errorf("TargetPort = %d, want %d", pv.TargetPort, store.DefaultPortLo)
	}
	for _, line := range strings.Split(strings.TrimSpace(pv.RouteDiff), "\n") {
		if strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---") {
			t.Errorf("diff against a missing file removes %q", line)
		}
	}
	if !strings.Contains(pv.RouteDiff, "@@ -0,0 +1,2 @@") || !strings.Contains(pv.RouteDiff, "+reverse_proxy 127.0.0.1:20000") {
		t.Errorf("RouteDiff is not the whole new route:\n%s", pv.RouteDiff)
	}
}

func TestPreview_InPlace(t *testing.T) {
	r := newPreviewRig(t)
	cfg := config.Deployment{
		Strategy: config.DeploymentStrategyComposeInplace,
		Compose:  &config.DeploymentCompose{Project: "web", File: "compose.yml", Service: "web"},
		Migrate:  &config.DeploymentMigrate{Run: "./migrate up"},
		Health:   &config.DeploymentHealth{Url: "http://127.0.0.1:8080/healthz", Retries: 3, Interval: "1s"},
	}

	pv := r.preview(t, cfg)

	if want := []string{"build", "migrate", "up", "health"}; !slices.Equal(pv.Steps, want) {
		t.Errorf("Steps = %v, want %v", pv.Steps, want)
	}
	if pv.Image != "web:0123456" || !strings.Contains(pv.Override, "web:0123456") {
		t.Errorf("Image = %q, Override:\n%s", pv.Image, pv.Override)
	}
	if pv.ActiveColor != "" || pv.TargetColor != "" || pv.TargetPort != 0 || pv.RouteDiff != "" {
		t.Errorf("in-place preview has colors, port or route: %+v", pv)
	}
	if len(r.exec.calls) != 0 {
		t.Errorf("executor ran %v", r.exec.calls)
	}
}

func TestPreview_Script(t *testing.T) {
	r := newPreviewRig(t)
	run := "./deploy.sh"

	pv := r.preview(t, config.Deployment{Strategy: config.DeploymentStrategyScript, Run: &run})

	if want := []string{"run"}; !slices.Equal(pv.Steps, want) {
		t.Errorf("Steps = %v, want %v", pv.Steps, want)
	}
	if pv.Image != "" || pv.Override != "" || pv.RouteDiff != "" {
		t.Errorf("script preview has image, override or route: %+v", pv)
	}
	if len(r.exec.calls) != 0 {
		t.Errorf("executor ran %v", r.exec.calls)
	}
}

// noPreview is a strategy without a dry run.
type noPreview struct{}

func (noPreview) Name() string { return "manual" }
func (noPreview) Plan(store.DeployRun, config.Deployment) ([]deploy.Step, error) {
	return nil, nil
}
func (noPreview) Rollback(context.Context, *deploy.StepContext, int) error { return nil }

func TestBuildPreview_StrategyWithoutPreview(t *testing.T) {
	e := &deploy.Engine{Strategies: map[string]deploy.DeployStrategy{"manual": noPreview{}}}
	_, err := deploy.BuildPreview(context.Background(), e, deploy.PreviewContext{
		Repo: pvRepo, Env: pvEnv, SHA: pvSHA, Cfg: config.Deployment{Strategy: "manual"},
	})
	if !errors.Is(err, deploy.ErrNoPreview) {
		t.Errorf("err = %v, want ErrNoPreview", err)
	}
}

// The deploy_plan op previews the last deployed commit when the request
// names none, loading the deployment through the engine.
func TestPlanHandler_DefaultsToLastDeployedSHA(t *testing.T) {
	r := newPreviewRig(t)
	cfg := r.blueGreen()
	bluePort := r.activateBlue(t, cfg)
	ctx := context.Background()
	if err := r.store.SetDeployState(ctx, store.DeployState{Repo: pvRepo, Env: pvEnv, ActiveColor: "blue", LastSuccessSHA: pvSHA}); err != nil {
		t.Fatal(err)
	}
	var loaded store.DeployRun
	r.engine.LoadDeployment = func(_ context.Context, run store.DeployRun) (config.Deployment, error) {
		loaded = run
		return cfg, nil
	}
	var ops []string
	var handler func(context.Context, json.RawMessage) (any, error)
	deploy.RegisterPlan(func(op string, h func(context.Context, json.RawMessage) (any, error)) {
		ops = append(ops, op)
		handler = h
	}, r.engine, r.store)
	if !slices.Equal(ops, []string{"deploy_plan"}) {
		t.Fatalf("registered ops %v, want [deploy_plan]", ops)
	}

	out, err := handler(ctx, json.RawMessage(`{"repo":"acme/web","env":"staging"}`))
	if err != nil {
		t.Fatalf("deploy_plan: %v", err)
	}
	if loaded.SHA != pvSHA || loaded.Repo != pvRepo || loaded.Env != pvEnv {
		t.Errorf("loaded deployment for %+v, want %s %s at %s", loaded, pvRepo, pvEnv, pvSHA)
	}
	pv, ok := out.(deploy.PlanPreview)
	if !ok {
		t.Fatalf("deploy_plan answered %T, want PlanPreview", out)
	}
	if pv.ActiveColor != "blue" || pv.TargetColor != "green" || pv.TargetPort != bluePort+1 {
		t.Errorf("colors %q -> %q port %d, want blue -> green port %d", pv.ActiveColor, pv.TargetColor, pv.TargetPort, bluePort+1)
	}
	if !strings.Contains(pv.Image, ":0123456") {
		t.Errorf("image %q is not tagged with the last deployed commit", pv.Image)
	}
}

// A request without a sha for an env that never deployed is refused rather
// than previewing an arbitrary commit.
func TestPlanHandler_NoDeployedCommit(t *testing.T) {
	r := newPreviewRig(t)
	r.engine.LoadDeployment = func(context.Context, store.DeployRun) (config.Deployment, error) {
		t.Fatal("loaded a deployment without a commit")
		return config.Deployment{}, nil
	}
	_, err := deploy.PlanHandler(r.engine, r.store)(context.Background(), json.RawMessage(`{"repo":"acme/web","env":"staging"}`))
	if err == nil || !strings.Contains(err.Error(), "has no deployed commit") {
		t.Errorf("err = %v, want no deployed commit", err)
	}
}

// countPortAllocations counts port_allocations rows through a second
// connection, so the count sees what the store committed.
func countPortAllocations(t *testing.T, dbPath string) int {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM port_allocations`).Scan(&n); err != nil {
		t.Fatalf("count port_allocations: %v", err)
	}
	return n
}

// snapshotTree maps every file under root to its contents. The database
// files are left out: SQLite owns their bytes, and the row count covers
// them.
func snapshotTree(t *testing.T, root string) map[string]string {
	t.Helper()
	tree := map[string]string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.HasPrefix(d.Name(), "agent.db") {
			return nil
		}
		if d.IsDir() {
			tree[path+"/"] = ""
			return nil
		}
		b, err := os.ReadFile(path)
		tree[path] = string(b)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return tree
}
