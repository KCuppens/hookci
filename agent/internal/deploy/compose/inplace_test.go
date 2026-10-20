package compose

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/health"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// eventLog records every deploy event.
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

func (l *eventLog) last() protocol.Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.events[len(l.events)-1]
}

type ipRig struct {
	store    *store.Store
	engine   *deploy.Engine
	strat    *InPlace
	exec     *recExecutor
	events   *eventLog
	cfg      config.Deployment
	workdir  string
	stateDir string
	chown    *fakeChown
	appPort  string
	status   atomic.Int64 // health status the app answers
	requests atomic.Int64
}

func newIPRig(t *testing.T) *ipRig {
	t.Helper()
	clk := autoClock{clock.NewFake(bgT0)}
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"), store.WithClock(clk.Now))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	r := &ipRig{store: st, exec: &recExecutor{}, events: &eventLog{}, workdir: t.TempDir(), stateDir: t.TempDir(), chown: &fakeChown{}}
	r.status.Store(http.StatusOK)
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		r.requests.Add(1)
		w.WriteHeader(int(r.status.Load()))
	}))
	t.Cleanup(app.Close)
	_, r.appPort, _ = net.SplitHostPort(app.Listener.Addr().String())

	compose := "services:\n  web:\n    build: .\n    container_name: myapp-web\n    ports:\n      - \"127.0.0.1:" + r.appPort + ":8080/tcp\"\n"
	if err := os.WriteFile(filepath.Join(r.workdir, "compose.yml"), []byte(compose), 0o644); err != nil {
		t.Fatal(err)
	}
	r.cfg = config.Deployment{
		Strategy: config.DeploymentStrategyComposeInplace,
		Compose:  &config.DeploymentCompose{Project: "myapp", File: "compose.yml", Service: "web"},
		Migrate:  &config.DeploymentMigrate{Run: "./migrate up"},
		Health:   &config.DeploymentHealth{Url: "http://127.0.0.1:{port}/healthz", Retries: 3, Interval: "1s"},
	}
	r.strat = &InPlace{
		Health:   &health.Checker{Clock: clk},
		StateDir: r.stateDir,
		WorkDir:  func(store.DeployRun) string { return r.workdir },
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

func (r *ipRig) deploy(t *testing.T) store.DeployRun {
	t.Helper()
	ctx := context.Background()
	if err := r.store.InsertDeployRun(ctx, store.DeployRun{
		RunID: "r1", Repo: bgRepo, Env: bgEnv, SHA: bgSHA, Ref: "refs/heads/main",
		Strategy: r.strat.Name(), State: store.DeployQueued, CreatedAt: bgT0,
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

func TestInPlace_Plan(t *testing.T) {
	r := newIPRig(t)
	run := store.DeployRun{Repo: bgRepo, Env: bgEnv, SHA: bgSHA}
	tests := []struct {
		name    string
		migrate *config.DeploymentMigrate
		want    []string
	}{
		{"with migrate", &config.DeploymentMigrate{Run: "./migrate up"}, []string{"build", "migrate", "up", "health"}},
		{"with migrate.before", &config.DeploymentMigrate{Run: "./migrate up",
			Before: &config.DeploymentMigrateBefore{Run: "pg_dump", OutputDir: new("/var/backups/app")}},
			[]string{"build", "migrate-before", "migrate", "up", "health"}},
		{"empty migrate.run", &config.DeploymentMigrate{}, []string{"build", "up", "health"}},
		{"no migrate", nil, []string{"build", "up", "health"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := r.cfg
			cfg.Migrate = tt.migrate
			steps, err := r.strat.Plan(run, cfg)
			if err != nil {
				t.Fatalf("Plan: %v", err)
			}
			var names []string
			for _, s := range steps {
				names = append(names, s.Name)
				want := deploy.PhaseApply
				if s.Name == "health" {
					want = deploy.PhaseVerify
				}
				if s.Phase != want {
					t.Errorf("%s phase = %v, want %v", s.Name, s.Phase, want)
				}
			}
			if !slices.Equal(names, tt.want) {
				t.Errorf("steps = %v, want %v", names, tt.want)
			}
		})
	}

	cfg := r.cfg
	cfg.Compose = nil
	if _, err := r.strat.Plan(run, cfg); err == nil || !strings.HasPrefix(err.Error(), "deployments.production.compose: required") {
		t.Errorf("Plan without compose: error = %v", err)
	}
}

func TestInPlace_Deploy(t *testing.T) {
	r := newIPRig(t)
	run := r.deploy(t)
	if run.State != store.DeploySuccess {
		t.Fatalf("state = %s (%s), want Success", run.State, run.Error)
	}
	file := filepath.Join(r.workdir, "compose.yml")
	override := filepath.Join(r.stateDir, "deploy", bgRepo, bgEnv, "inplace.override.yml")
	compose := "docker compose -p myapp -f " + file + " -f " + override
	want := []string{
		"docker image inspect myapp:abcdef1",
		"docker build -t myapp:abcdef1 -f Dockerfile .",
		compose + " run --rm web sh -c ./migrate up",
		compose + " up -d --remove-orphans",
	}
	if got := r.exec.commands(); !slices.Equal(got, want) {
		t.Errorf("commands =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	got, err := os.ReadFile(override)
	if err != nil {
		t.Fatal(err)
	}
	if want := "services:\n  web:\n    image: myapp:abcdef1\n"; string(got) != want {
		t.Errorf("override =\n%s\nwant\n%s", got, want)
	}
	wantHandedOver(t, r.chown, r.stateDir, override, []byte("services:\n  web:\n    image: myapp:abcdef1\n"))
	if entries, err := os.ReadDir(r.workdir); err != nil || len(entries) != 1 {
		t.Errorf("checkout entries = %v, %v; want only compose.yml, the agent writes nothing there", entries, err)
	}
	if r.requests.Load() == 0 {
		t.Error("health never reached the published port " + r.appPort)
	}
}

func TestInPlace_HealthFailure_NoRollback(t *testing.T) {
	r := newIPRig(t)
	r.status.Store(http.StatusServiceUnavailable)
	run := r.deploy(t)
	if run.State != store.DeployFailed {
		t.Fatalf("state = %s, want Failed", run.State)
	}
	if !strings.Contains(run.Error, "deployments.production.health:") {
		t.Errorf("error = %q, want the health failure", run.Error)
	}
	if d := downs(r.exec.commands()); len(d) != 0 {
		t.Errorf("rollback brought down %v, want nothing", d)
	}
	if tail := r.events.last().Tail; !slices.Contains(tail, "compose-inplace has no rollback") {
		t.Errorf("tail %q lacks the no-rollback line", tail)
	}
}

func TestPublishedPort(t *testing.T) {
	tests := []struct {
		service string
		want    int
	}{
		{`ports: ["8080:80"]`, 8080},
		{`ports: ["127.0.0.1:3000:8080/tcp"]`, 3000},
		{`ports: ["[::1]:3001:80"]`, 3001},
		{"ports:\n      - target: 80\n        published: 8443", 8443},
		{"ports:\n      - target: 80\n        published: \"8444\"", 8444},
	}
	for _, tt := range tests {
		got, err := PublishedPort(bgEnv, writeCompose(t, tt.service), "web")
		if err != nil || got != tt.want {
			t.Errorf("%s: PublishedPort = %d, %v; want %d", tt.service, got, err, tt.want)
		}
	}
	for _, service := range []string{
		`ports: ["8080"]`,
		`ports: [8080]`,
		`ports: ["8000-8010:8000-8010"]`,
		`ports: ["${PORT}:80"]`,
		"ports:\n      - target: 80",
		`expose: ["8080"]`,
	} {
		if got, err := PublishedPort(bgEnv, writeCompose(t, service), "web"); err == nil ||
			!strings.HasPrefix(err.Error(), "deployments.production.compose.service: service web publishes no") {
			t.Errorf("%s: PublishedPort = %d, %v; want a publishes-no error", service, got, err)
		}
	}
}

func TestInPlace_HealthWithoutPortPlaceholder(t *testing.T) {
	r := newIPRig(t)
	// The compose file publishes no fixed port; a URL without {port} needs none.
	if err := os.WriteFile(filepath.Join(r.workdir, "compose.yml"), []byte("services:\n  web:\n    build: .\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r.cfg.Health.Url = fmt.Sprintf("http://127.0.0.1:%s/healthz", r.appPort)
	if run := r.deploy(t); run.State != store.DeploySuccess {
		t.Fatalf("state = %s (%s), want Success", run.State, run.Error)
	}
}
