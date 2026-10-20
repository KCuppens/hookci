//go:build integration

package integration

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/control"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/compose"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/health"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/strategies"
	"github.com/KCuppens/zerocideploy/agent/internal/executor"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/gc"
	"github.com/KCuppens/zerocideploy/agent/internal/ids"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy/caddy"
	"github.com/KCuppens/zerocideploy/agent/internal/redact"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

const (
	itRepo = "itest/compose-app"
	itEnv  = "staging"

	// agentStateEnv, when set, makes the test binary run as a zeroci agent
	// over that state dir instead of running tests (see TestMain).
	agentStateEnv = "ZEROCI_ITEST_AGENT_STATE"
	// holdStepEnv names a step the agent subprocess blocks in until killed.
	holdStepEnv = "ZEROCI_ITEST_HOLD_STEP"
	specName    = "itest-agent.json"

	runTimeout  = 10 * time.Minute
	pollEvery   = 250 * time.Millisecond
	loadTimeout = 2 * time.Second
)

var colors = []string{"blue", "green"}

func TestMain(m *testing.M) {
	if dir := os.Getenv(agentStateEnv); dir != "" {
		os.Exit(agentMain(dir, os.Getenv(holdStepEnv)))
	}
	os.Exit(m.Run())
}

// agentSpec is what an agent, in process or in a subprocess, deploys the
// fixture with. The harness writes it to <StateDir>/itest-agent.json.
type agentSpec struct {
	StateDir  string `json:"state_dir"`
	Fixture   string `json:"fixture"` // absolute path of examples/compose-app
	Project   string `json:"project"` // replaces compose.project
	RouteFile string `json:"route_file"`
	Reload    string `json:"reload"`
	// VerifyWindow and VerifyInterval replace verify.window and
	// verify.interval when VerifyWindow is set.
	VerifyWindow   string `json:"verify_window,omitempty"`
	VerifyInterval string `json:"verify_interval,omitempty"`
}

// runFile is where the harness leaves per-run input: <id>.version is the
// VERSION the checkout carries, <id>.env the env_file of the run. It lives
// outside deploy-work, which GC removes once a run ends.
func (s agentSpec) runFile(runID, ext string) string {
	return filepath.Join(s.StateDir, "itest-runs", runID+ext)
}

func (s agentSpec) workDir(run store.DeployRun) string {
	return filepath.Join(s.StateDir, "deploy-work", run.RunID)
}

// deployment is deployments.<env> of the fixture, pointed at this test's
// compose project and caddy, with the run's env file when it has one.
func (s agentSpec) deployment(env, runID string) (config.Deployment, error) {
	path := filepath.Join(s.Fixture, ".zeroci.yml")
	cfg, diags, err := config.Load(path, config.ParseOptions{})
	if err != nil {
		return config.Deployment{}, fmt.Errorf("integration: %w", err)
	}
	if diags.HasErrors() {
		return config.Deployment{}, fmt.Errorf("integration: %s", diags.Format(path))
	}
	d, ok := cfg.Deployments[env]
	if !ok {
		return config.Deployment{}, fmt.Errorf("integration: fixture has no deployments.%s", env)
	}
	c := *d.Compose
	c.Project = s.Project
	d.Compose = &c
	r := *d.Route
	r.File, r.Reload = s.RouteFile, s.Reload
	d.Route = &r
	if s.VerifyWindow != "" {
		v := *d.Verify
		v.Window, v.Interval = s.VerifyWindow, s.VerifyInterval
		d.Verify = &v
	}
	if runID != "" {
		envFile := s.runFile(runID, ".env")
		if _, err := os.Stat(envFile); err == nil {
			d.EnvFile = &envFile
		}
	}
	return d, nil
}

// checkout copies the fixture to the run's work dir, owned by the deploy
// user, with app/VERSION set for the run. Like the daemon's checkout it
// builds <dir>.partial first and reuses a finished dir.
func (s agentSpec) checkout(_ context.Context, run store.DeployRun) error {
	dir := s.workDir(run)
	if _, err := os.Stat(dir); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("integration: checkout: %w", err)
	}
	cred, err := isolation.LookupCredential(deploy.DeployUser)
	if err != nil {
		return fmt.Errorf("integration: checkout: %w", err)
	}
	root := filepath.Dir(dir)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("integration: checkout: %w", err)
	}
	if err := executor.OpenTo(s.StateDir, cred, root); err != nil {
		return fmt.Errorf("integration: checkout: %w", err)
	}
	partial := dir + ".partial"
	if err := os.RemoveAll(partial); err != nil {
		return fmt.Errorf("integration: checkout: %w", err)
	}
	if err := os.CopyFS(partial, os.DirFS(s.Fixture)); err != nil {
		return fmt.Errorf("integration: checkout: %w", err)
	}
	version, err := os.ReadFile(s.runFile(run.RunID, ".version"))
	if err != nil {
		return fmt.Errorf("integration: checkout: %w", err)
	}
	if err := os.WriteFile(filepath.Join(partial, "app", "VERSION"), version, 0o644); err != nil {
		return fmt.Errorf("integration: checkout: %w", err)
	}
	err = filepath.WalkDir(partial, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(p, int(cred.Uid), int(cred.Gid))
	})
	if err != nil {
		return fmt.Errorf("integration: checkout: %w", err)
	}
	if err := os.Rename(partial, dir); err != nil {
		return fmt.Errorf("integration: checkout: %w", err)
	}
	return nil
}

// agent is the deploy lane of a zeroci agent, wired like the daemon's:
// engine, scheduler, recovery and GC after each run, with real docker and
// caddy. It has no disk preflight.
type agent struct {
	sched *deploy.Scheduler
	rec   *deploy.Recoverer
}

func newAgent(spec agentSpec, st *store.Store, events deploy.EventSink, log *slog.Logger, holdStep string) *agent {
	runner := execx.OS{}
	strats := strategies.New(strategies.Deps{
		Store: st,
		Proxy: func(route config.DeploymentRoute) (proxy.ProxyAdapter, error) {
			return caddy.New(runner, route.Reload)
		},
		Health:   &health.Checker{},
		Clock:    clock.Real{},
		StateDir: spec.StateDir,
		WorkDir:  spec.workDir,
		Access: &compose.UnitAccess{Cred: func() (*syscall.Credential, error) {
			return isolation.LookupCredential(deploy.DeployUser)
		}},
	})
	if holdStep != "" {
		for name, s := range strats {
			strats[name] = holdAt{DeployStrategy: s, step: holdStep}
		}
	}
	load := func(_ context.Context, run store.DeployRun) (config.Deployment, error) {
		return spec.deployment(run.Env, run.RunID)
	}
	eng := &deploy.Engine{
		Store:          st,
		Strategies:     strats,
		Events:         events,
		Clock:          clock.Real{},
		LoadDeployment: load,
		NewExecutor: func(ctx context.Context, run store.DeployRun, cfg config.Deployment) (deploy.Executor, error) {
			trusted, err := st.DeployRunAccepted(ctx, run.RunID)
			if err != nil {
				return nil, fmt.Errorf("integration: %w", err)
			}
			red, _ := redact.New(nil, nil)
			return deploy.NewExecutorForRun(run, trusted, cfg, deploy.ExecutorDeps{Runner: runner, Redactor: red})
		},
		Checkout: spec.checkout,
	}
	collector := &gc.Collector{
		Runner:   runner,
		Store:    st,
		StateDir: spec.StateDir,
		Repos: func(context.Context) ([]gc.RepoEnv, error) {
			d, err := spec.deployment(itEnv, "")
			if err != nil {
				return nil, err
			}
			return []gc.RepoEnv{{Repo: itRepo, Env: itEnv, Project: spec.Project, Retain: d.Retain.Images}}, nil
		},
		Log: log,
	}
	return &agent{
		sched: &deploy.Scheduler{
			Store: st, Engine: eng, Events: events, Clock: time.Now, Logger: log,
			LoadDeployment: load,
			PostRun:        func(ctx context.Context, _ store.DeployRun) { collector.RunBestEffort(ctx) },
		},
		rec: &deploy.Recoverer{Store: st, Runner: runner, Events: events, Logger: log},
	}
}

// start recovers what a previous agent left, as the daemon does at startup,
// and runs the scheduler until ctx ends.
func (a *agent) start(ctx context.Context) error {
	if _, err := a.rec.Recover(ctx); err != nil {
		return fmt.Errorf("integration: %w", err)
	}
	if err := a.sched.Recover(ctx); err != nil {
		return fmt.Errorf("integration: %w", err)
	}
	go a.sched.Run(ctx)
	return nil
}

// holdAt is a strategy whose step named step blocks until the run's context
// ends, so a test can kill the agent at a known step.
type holdAt struct {
	deploy.DeployStrategy
	step string
}

func (h holdAt) Plan(run store.DeployRun, cfg config.Deployment) ([]deploy.Step, error) {
	steps, err := h.DeployStrategy.Plan(run, cfg)
	if err != nil {
		return nil, err
	}
	for i := range steps {
		if steps[i].Name == h.step {
			steps[i].Run = func(ctx context.Context, _ *deploy.StepContext) error {
				<-ctx.Done()
				return ctx.Err()
			}
		}
	}
	return steps, nil
}

// agentMain is the agent subprocess: it serves the control socket, so
// `zeroci retry` reaches it, and deploys until SIGTERM.
func agentMain(stateDir, holdStep string) int {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := runAgent(stateDir, holdStep, log); err != nil {
		log.Error("agent failed", "err", err)
		return 1
	}
	return 0
}

func runAgent(stateDir, holdStep string, log *slog.Logger) error {
	raw, err := os.ReadFile(filepath.Join(stateDir, specName))
	if err != nil {
		return fmt.Errorf("integration: %w", err)
	}
	var spec agentSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return fmt.Errorf("integration: %s: %w", specName, err)
	}
	st, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		return fmt.Errorf("integration: %w", err)
	}
	defer st.Close()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	a := newAgent(spec, st, logEvents{log}, log, holdStep)
	if err := a.start(ctx); err != nil {
		return err
	}
	ctl, err := control.Listen(stateDir, log)
	if err != nil {
		return fmt.Errorf("integration: %w", err)
	}
	ctl.Handle(deploy.RetryOp, deploy.RetryControl(st, a.sched))
	if err := ctl.Serve(ctx); err != nil && ctx.Err() == nil {
		return fmt.Errorf("integration: %w", err)
	}
	a.sched.Wait()
	return nil
}

// logEvents is the event sink of the agent subprocess.
type logEvents struct{ log *slog.Logger }

func (logEvents) DeployPlanned(protocol.JobPlanned) {}

func (l logEvents) DeployEvent(ev protocol.Event) {
	l.log.Info("deploy event", "run", ev.RunId, "state", ev.State, "tail", ev.Tail)
}

// eventLog records the events of the in-process agent.
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

// last returns the newest event of runID.
func (l *eventLog) last(runID string) (protocol.Event, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := len(l.events) - 1; i >= 0; i-- {
		if l.events[i].RunId == runID {
			return l.events[i], true
		}
	}
	return protocol.Event{}, false
}

// harness is one test's environment: a temp state dir, a caddy serving the
// route file on a front port, a compose project of its own, and either an
// in-process agent or agent subprocesses. Agent and caddy logs stay in the
// state dir, which is kept when the test fails.
type harness struct {
	spec   agentSpec
	st     *store.Store
	front  string // http://127.0.0.1:<port>
	events *eventLog
	agent  *agent // nil in subprocess mode

	agentLogs int
}

type harnessOpts struct {
	// subprocess leaves the agent to startAgent instead of running it in
	// the test process.
	subprocess bool
	// verifyWindow and verifyInterval replace the fixture's verify block.
	verifyWindow, verifyInterval string
}

func newHarness(t *testing.T, o harnessOpts) *harness {
	t.Helper()
	testutil.RequireIntegration(t)
	for _, bin := range []string{"docker", "caddy", "systemd-run"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Fatalf("%s is not in PATH: %v", bin, err)
		}
	}
	testutil.EnsureUser(t, deploy.DeployUser)
	mustRun(t, "usermod", "-aG", "docker", deploy.DeployUser)

	fixture, err := filepath.Abs(fixtureDir)
	if err != nil {
		t.Fatal(err)
	}
	stateDir, err := os.MkdirTemp("", "zeroci-m2-")
	if err != nil {
		t.Fatal(err)
	}
	project := "zcit" + randHex(t, 4)
	// Registered first, so it runs after the agent and caddy have stopped.
	t.Cleanup(func() {
		for _, c := range colors {
			if err := run("docker", "compose", "-p", project+"-"+c, "down", "--remove-orphans"); err != nil {
				t.Log(err)
			}
		}
		for _, tag := range projectImages(t, project) {
			if err := run("docker", "image", "rm", "-f", project+":"+tag); err != nil {
				t.Log(err)
			}
		}
		if t.Failed() {
			t.Logf("state dir kept for inspection: %s", stateDir)
			return
		}
		_ = os.RemoveAll(stateDir)
	})

	routes := filepath.Join(stateDir, "caddy", "routes")
	if err := os.MkdirAll(routes, 0o755); err != nil {
		t.Fatal(err)
	}
	caddyfile, port := startCaddy(t, fixture, stateDir, routes)
	h := &harness{
		spec: agentSpec{
			StateDir:       stateDir,
			Fixture:        fixture,
			Project:        project,
			RouteFile:      filepath.Join(routes, project+"-"+itEnv+".caddy"),
			Reload:         "caddy reload --config " + caddyfile + " --adapter caddyfile",
			VerifyWindow:   o.verifyWindow,
			VerifyInterval: o.verifyInterval,
		},
		front:  "http://127.0.0.1:" + strconv.Itoa(port),
		events: &eventLog{},
	}
	raw, err := json.Marshal(h.spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, specName), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(stateDir, "itest-runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	h.st, err = store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.st.Close() })

	if !o.subprocess {
		logf, err := os.Create(filepath.Join(stateDir, "agent.log"))
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		h.agent = newAgent(h.spec, h.st, h.events, slog.New(slog.NewTextHandler(logf, nil)), "")
		t.Cleanup(func() {
			cancel()
			h.agent.sched.Wait()
			_ = logf.Close()
		})
		if err := h.agent.start(ctx); err != nil {
			t.Fatal(err)
		}
	}
	return h
}

// startCaddy runs caddy with the fixture's Caddyfile, pointed at routes,
// an admin socket in stateDir and a free front port.
func startCaddy(t *testing.T, fixture, stateDir, routes string) (caddyfile string, port int) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixture, "Caddyfile"))
	if err != nil {
		t.Fatal(err)
	}
	port = freePort(t)
	dir := filepath.Join(stateDir, "caddy")
	conf := string(raw)
	for _, r := range [][2]string{
		{"/etc/caddy/routes/", routes + "/"},
		{"unix//run/caddy/admin.sock", "unix/" + filepath.Join(dir, "admin.sock")},
		{":8088", ":" + strconv.Itoa(port)},
	} {
		if !strings.Contains(conf, r[0]) {
			t.Fatalf("fixture Caddyfile no longer contains %q", r[0])
		}
		conf = strings.ReplaceAll(conf, r[0], r[1])
	}
	caddyfile = filepath.Join(dir, "Caddyfile")
	if err := os.WriteFile(caddyfile, []byte(conf), 0o644); err != nil {
		t.Fatal(err)
	}
	logf, err := os.Create(filepath.Join(dir, "caddy.log"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("caddy", "run", "--config", caddyfile, "--adapter", "caddyfile")
	cmd.Env = append(os.Environ(), "XDG_DATA_HOME="+filepath.Join(dir, "data"), "XDG_CONFIG_HOME="+filepath.Join(dir, "config"))
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		_ = cmd.Wait()
		_ = logf.Close()
	})
	waitFor(t, 30*time.Second, "caddy to listen on the front port", func() bool {
		c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), time.Second)
		if err != nil {
			return false
		}
		_ = c.Close()
		return true
	})
	return caddyfile, port
}

// queueRun stores a Queued, accepted deploy run of a fresh sha whose
// checkout reports version, with env as its env_file. It does not enqueue it.
func (h *harness) queueRun(t *testing.T, version string, env map[string]string) string {
	t.Helper()
	ctx := context.Background()
	runID := ids.NewRunID()
	if err := os.WriteFile(h.spec.runFile(runID, ".version"), []byte(version+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if len(env) > 0 {
		var b strings.Builder
		for _, k := range slices.Sorted(maps.Keys(env)) {
			fmt.Fprintf(&b, "%s=%s\n", k, env[k])
		}
		if err := os.WriteFile(h.spec.runFile(runID, ".env"), []byte(b.String()), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	err := h.st.InsertDeployRun(ctx, store.DeployRun{
		RunID: runID, Repo: itRepo, Env: itEnv, SHA: randHex(t, 20), Ref: "refs/heads/main",
		Strategy: "compose-bluegreen", State: store.DeployQueued,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.st.AnswerTrigger(ctx, "trg-"+runID, runID, ""); err != nil {
		t.Fatal(err)
	}
	return runID
}

// startDeploy queues a run on the in-process agent and returns its id.
func (h *harness) startDeploy(t *testing.T, version string, env map[string]string) string {
	t.Helper()
	runID := h.queueRun(t, version, env)
	h.agent.sched.Enqueue(context.Background(), runID, false)
	return runID
}

// deploy runs one deploy on the in-process agent to its end, GC included.
func (h *harness) deploy(t *testing.T, version string, env map[string]string) store.DeployRun {
	t.Helper()
	return h.wait(t, h.startDeploy(t, version, env))
}

// wait polls runID until it ends and, in process, until GC after it ran.
func (h *harness) wait(t *testing.T, runID string) store.DeployRun {
	t.Helper()
	run := h.waitState(t, runID, store.DeploySuccess, store.DeployFailed, store.DeployInterrupted, store.DeploySuperseded)
	if h.agent != nil {
		h.agent.sched.Wait()
	}
	if run.State == store.DeployFailed {
		if ev, ok := h.events.last(runID); ok {
			t.Logf("run %s failed; log tail:\n%s", runID, strings.Join(ev.Tail, "\n"))
		}
	}
	return run
}

// waitState polls runID until its state is one of states.
func (h *harness) waitState(t *testing.T, runID string, states ...string) store.DeployRun {
	t.Helper()
	var run store.DeployRun
	waitFor(t, runTimeout, "deploy run "+runID+" to reach "+strings.Join(states, "|"), func() bool {
		var err error
		run, err = h.st.GetDeployRun(context.Background(), runID)
		if err != nil {
			t.Fatal(err)
		}
		return slices.Contains(states, run.State)
	})
	return run
}

// waitStepRunning waits until step name of runID is running.
func (h *harness) waitStepRunning(t *testing.T, runID, name string) {
	t.Helper()
	waitFor(t, runTimeout, "step "+name+" of "+runID+" to run", func() bool {
		steps, err := h.st.ListSteps(context.Background(), runID)
		if err != nil {
			t.Fatal(err)
		}
		return slices.ContainsFunc(steps, func(s store.DeployStep) bool {
			return s.Name == name && s.Status == store.StepRunning
		})
	})
}

// stepNames returns the names of the recorded steps of runID in order.
func (h *harness) stepNames(t *testing.T, runID string) []string {
	t.Helper()
	steps, err := h.st.ListSteps(context.Background(), runID)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, len(steps))
	for i, s := range steps {
		names[i] = s.Name
	}
	return names
}

// failedStep returns the name of the step of runID that failed.
func (h *harness) failedStep(t *testing.T, runID string) string {
	t.Helper()
	steps, err := h.st.ListSteps(context.Background(), runID)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range steps {
		if s.Status == store.StepFailed {
			return s.Name
		}
	}
	t.Fatalf("run %s has no failed step: %+v", runID, steps)
	return ""
}

// requireFailedEvent checks the terminal event of a failed run: state
// failed at step, with the log tail.
func (h *harness) requireFailedEvent(t *testing.T, runID, step string) {
	t.Helper()
	ev, ok := h.events.last(runID)
	if !ok {
		t.Fatalf("no event for run %s", runID)
	}
	if ev.State != protocol.EventStateFailed {
		t.Fatalf("last event of %s has state %q, want %q", runID, ev.State, protocol.EventStateFailed)
	}
	if ev.Step == nil || *ev.Step != step {
		t.Fatalf("failed event of %s has step %v, want %q", runID, ev.Step, step)
	}
	if len(ev.Tail) == 0 {
		t.Fatalf("failed event of %s has an empty tail", runID)
	}
}

// serving returns the version caddy serves on the front port.
func (h *harness) serving(t *testing.T) string {
	t.Helper()
	c := &http.Client{Timeout: loadTimeout}
	resp, err := c.Get(h.front + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / through caddy: %s: %s", resp.Status, body)
	}
	v, ok := strings.CutPrefix(strings.TrimSpace(string(body)), "version=")
	if !ok {
		t.Fatalf("GET / through caddy: unexpected body %q", body)
	}
	return v
}

// marker returns the active color the marker file records.
func (h *harness) marker(t *testing.T) string {
	t.Helper()
	c, err := compose.ReadMarker(filepath.Join(h.spec.StateDir, "deploy", itRepo, itEnv, "active-color"))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// routeFile returns the route file's content, "" when there is none.
func (h *harness) routeFile(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(h.spec.RouteFile)
	if errors.Is(err, fs.ErrNotExist) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

var routeColorRe = regexp.MustCompile(`color=(blue|green)\b`)

// routeColor returns the color the route file sends traffic to.
func (h *harness) routeColor(t *testing.T) string {
	t.Helper()
	content := h.routeFile(t)
	m := routeColorRe.FindStringSubmatch(content)
	if m == nil {
		t.Fatalf("route file %s names no color:\n%s", h.spec.RouteFile, content)
	}
	return m[1]
}

// activeColor returns deploy_state's active color.
func (h *harness) activeColor(t *testing.T) string {
	t.Helper()
	ds, ok, err := h.st.GetDeployState(context.Background(), itRepo, itEnv)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("no deploy_state recorded")
	}
	return ds.ActiveColor
}

// containers returns the ids of the containers of color, stopped ones
// included.
func (h *harness) containers(t *testing.T, color string) []string {
	t.Helper()
	out := mustOutput(t, "docker", "ps", "-aq", "--filter", "label=com.docker.compose.project="+h.spec.Project+"-"+color)
	return strings.Fields(out)
}

// requireConsistent checks that the marker, deploy_state and the route
// file agree on one color, that only that color has containers, and that
// caddy serves version.
func (h *harness) requireConsistent(t *testing.T, version string) {
	t.Helper()
	active := h.marker(t)
	if active != "blue" && active != "green" {
		t.Fatalf("marker = %q, want blue or green", active)
	}
	if got := h.activeColor(t); got != active {
		t.Fatalf("deploy_state active color %q, marker %q", got, active)
	}
	if got := h.routeColor(t); got != active {
		t.Fatalf("route file color %q, marker %q", got, active)
	}
	if len(h.containers(t, active)) == 0 {
		t.Fatalf("active color %s has no containers", active)
	}
	other := compose.OtherColor(active)
	if left := h.containers(t, other); len(left) != 0 {
		t.Fatalf("color %s is not active but has containers %v", other, left)
	}
	if got := h.serving(t); got != version {
		t.Fatalf("serving version %q, want %q", got, version)
	}
}

// startAgent runs the agent subprocess over the harness state dir; with
// holdStep set its runs block in that step. Its output goes to
// <state>/agent-<n>.log. Cleanup stops it if the test has not.
func (h *harness) startAgent(t *testing.T, holdStep string) *exec.Cmd {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	h.agentLogs++
	logf, err := os.Create(filepath.Join(h.spec.StateDir, fmt.Sprintf("agent-%d.log", h.agentLogs)))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^$")
	cmd.Env = append(os.Environ(), agentStateEnv+"="+h.spec.StateDir, holdStepEnv+"="+holdStep)
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
		_ = logf.Close()
	})
	return cmd
}

// stopAgent stops an agent subprocess with SIGTERM and waits for it.
func stopAgent(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("agent exited: %v", err)
	}
}

// killAgent kills an agent subprocess with SIGKILL and reaps it.
func killAgent(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
}

// load sends GET / through caddy at a fixed rate and counts failures: a
// transport error, a timeout or a non-200 answer.
type load struct {
	ok, failed atomic.Int64
	mu         sync.Mutex
	samples    []string // the first failures
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

func (h *harness) startLoad(perSecond int) *load {
	ctx, cancel := context.WithCancel(context.Background())
	l := &load{cancel: cancel}
	client := &http.Client{Timeout: loadTimeout}
	tick := time.NewTicker(time.Second / time.Duration(perSecond))
	l.wg.Add(1)
	go func() {
		defer l.wg.Done()
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
			l.wg.Add(1)
			go func() {
				defer l.wg.Done()
				l.hit(client, h.front+"/")
			}()
		}
	}()
	return l
}

func (l *load) hit(client *http.Client, url string) {
	resp, err := client.Get(url)
	if err == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			l.ok.Add(1)
			return
		}
		err = fmt.Errorf("status %s", resp.Status)
	}
	l.failed.Add(1)
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.samples) < 20 {
		l.samples = append(l.samples, time.Now().Format(time.RFC3339Nano)+" "+err.Error())
	}
}

// stop ends the load and waits for the requests in flight.
func (l *load) stop() {
	l.cancel()
	l.wg.Wait()
}

// buildZeroci builds the zeroci binary for `zeroci retry`.
func buildZeroci(t *testing.T) string {
	t.Helper()
	gobin, err := exec.LookPath("go")
	if err != nil {
		t.Fatalf("go is not in PATH: %v", err)
	}
	bin := filepath.Join(t.TempDir(), "zeroci")
	mustRun(t, gobin, "build", "-o", bin, "github.com/KCuppens/zerocideploy/agent/cmd/zeroci")
	return bin
}

// projectImages returns the tags of project's images.
func projectImages(t *testing.T, project string) []string {
	t.Helper()
	return strings.Fields(mustOutput(t, "docker", "image", "ls", "--filter", "reference="+project, "--format", "{{.Tag}}"))
}

func waitFor(t *testing.T, timeout time.Duration, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", timeout, what)
		}
		time.Sleep(pollEvery)
	}
}

func run(name string, args ...string) error {
	if out, err := exec.Command(name, args...).CombinedOutput(); err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, out)
	}
	return nil
}

func mustRun(t *testing.T, name string, args ...string) {
	t.Helper()
	if err := run(name, args...); err != nil {
		t.Fatal(err)
	}
}

func mustOutput(t *testing.T, name string, args ...string) string {
	t.Helper()
	var stdout, stderr bytes.Buffer
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("%s %s: %v: %s", name, strings.Join(args, " "), err, stderr.String())
	}
	return stdout.String()
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func randHex(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}
