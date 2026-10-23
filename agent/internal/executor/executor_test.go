package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/cache"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/egress"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/isolation"
	"github.com/KCuppens/hookci/agent/internal/logpipe"
	"github.com/KCuppens/hookci/agent/internal/netns"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/redact"
	"github.com/KCuppens/hookci/agent/internal/scheduler"
	"github.com/KCuppens/hookci/agent/internal/services"
	"github.com/KCuppens/hookci/agent/internal/source"
	"github.com/KCuppens/hookci/agent/internal/store"
)

func job(name string) store.Job { return store.Job{RunID: "01run", Name: name} }

func setUp(t *testing.T, h *harness, run store.Run) {
	t.Helper()
	if err := h.ex.RunSetup(context.Background(), run); err != nil {
		t.Fatalf("RunSetup: %v", err)
	}
}

func finish(t *testing.T, h *harness, run store.Run, final store.RunState) {
	t.Helper()
	if err := h.ex.FinishRun(context.Background(), run, final); err != nil {
		t.Fatalf("FinishRun: %v", err)
	}
}

// drive runs run through a real scheduler and returns its final state once
// every runner call, FinishRun included, has returned.
func drive(t *testing.T, h *harness, runID string) store.RunState {
	t.Helper()
	ctx := context.Background()
	sched := scheduler.New(h.st, h.ex, scheduler.Options{Slots: 2})
	if _, err := sched.Submit(ctx, runID); err != nil {
		t.Fatal(err)
	}
	state, err := sched.Wait(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	if err := sched.Close(); err != nil {
		t.Fatal(err)
	}
	return state
}

func hasEnv(env []string, kv string) bool { return slices.Contains(env, kv) }

func TestRunJobSuccess(t *testing.T) {
	cfg := &config.ResolvedChecks{
		Limits: config.ResolvedLimits{CPUs: 2, MemoryBytes: 1 << 30, Tasks: 256, Timeout: time.Minute},
		Jobs:   []config.ResolvedJob{{Name: "build", Run: "make build"}},
	}
	h := newHarness(t, "none", cfg, nil)
	run := localRun()
	h.create(t, run, cfg)
	h.iso.jobs["build"] = func(_ context.Context, s isolation.Spec) (isolation.Result, error) {
		writeOut(s.Stdout, "::hookci step compile\nbuilt ok\n")
		return isolation.Result{}, nil
	}

	setUp(t, h, run)
	out, err := h.ex.RunJob(context.Background(), run, job("build"))
	if err != nil {
		t.Fatal(err)
	}
	finish(t, h, run, store.RunSuccess)

	if out.State != store.JobSuccess || out.ExitCode != 0 || out.Reason != "" {
		t.Errorf("outcome = %+v, want success with exit 0", out)
	}
	dir := h.runDir(run.ID)
	if log := readFile(t, logpipe.LogPath(dir.Root, "build")); !strings.Contains(log, "built ok") {
		t.Errorf("job log = %q, want the job output", log)
	}

	if len(h.src.reqs) != 1 || h.src.reqs[0].SHA != "" || h.src.reqs[0].Repo != "local/app" {
		t.Errorf("checkout requests = %+v, want one local/app HEAD checkout", h.src.reqs)
	}
	s := h.iso.spec(t, "build")
	if !slices.Equal(s.Argv, []string{"/bin/sh", "-ec", "make build"}) {
		t.Errorf("Argv = %q", s.Argv)
	}
	if s.Dir != dir.Src() || s.User != isolation.DefaultUser || s.NetNSPath != "" {
		t.Errorf("Dir %q User %q NetNSPath %q", s.Dir, s.User, s.NetNSPath)
	}
	if want := []string{dir.Src(), dir.Home(), dir.Tmp(), dir.PG()}; !slices.Equal(s.ReadWritePaths, want) {
		t.Errorf("ReadWritePaths = %q, want %q", s.ReadWritePaths, want)
	}
	if want := filepath.Dir(dir.Root); s.Hide != want {
		t.Errorf("Hide = %q, want the runs dir %q", s.Hide, want)
	}
	if want := (isolation.Limits{CPUs: 2, MemoryBytes: 1 << 30, Tasks: 256, Timeout: time.Minute}); s.Limits != want {
		t.Errorf("Limits = %+v, want %+v", s.Limits, want)
	}
	for _, kv := range []string{"HOOKCI_SHA=" + h.src.sha, "HOME=" + dir.Home(), "HTTPS_PROXY=http://127.0.0.1:4321"} {
		if !hasEnv(s.Env, kv) {
			t.Errorf("env lacks %s: %q", kv, s.Env)
		}
	}

	var steps []protocol.Event
	for _, ev := range frames[protocol.Event](t, h.st, store.KindEvent) {
		if ev.Step != nil && ev.Job != nil {
			steps = append(steps, ev)
		}
	}
	if len(steps) != 1 || *steps[0].Step != "compile" || *steps[0].StepIndex != 0 || *steps[0].Job != "build" {
		t.Errorf("step events = %+v, want one compile step at index 0", steps)
	}
}

func TestRunJobStepsTotal(t *testing.T) {
	script := "echo '::hookci step deps'\nnpm ci\necho '::hookci step compile'\nmake\n" +
		"echo '::hookci step test'\necho '::hookci step lint'\necho '::hookci step pack'\n"
	cfg := &config.ResolvedChecks{Jobs: []config.ResolvedJob{{Name: "build", Run: script}}}
	h := newHarness(t, "none", cfg, nil)
	run := localRun()
	h.create(t, run, cfg)
	h.iso.jobs["build"] = func(_ context.Context, s isolation.Spec) (isolation.Result, error) {
		writeOut(s.Stdout, "::hookci step deps\n::hookci step compile\n")
		return isolation.Result{}, nil
	}

	setUp(t, h, run)
	if _, err := h.ex.RunJob(context.Background(), run, job("build")); err != nil {
		t.Fatal(err)
	}
	finish(t, h, run, store.RunSuccess)

	var got []string
	for _, ev := range frames[protocol.Event](t, h.st, store.KindEvent) {
		if ev.Step != nil && ev.Job != nil && ev.StepsTotal != nil {
			got = append(got, fmt.Sprintf("%d/%d %s", *ev.StepIndex+1, *ev.StepsTotal, *ev.Step))
		}
	}
	if want := []string{"1/5 deps", "2/5 compile"}; !slices.Equal(got, want) {
		t.Errorf("steps = %q, want %q", got, want)
	}
}

func TestRunJobFailureTailAndReason(t *testing.T) {
	const secret = "s3cr3t-token-value-123"
	envFile := filepath.Join(t.TempDir(), "prod.env")
	if err := os.WriteFile(envFile, []byte("API_TOKEN="+secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.ResolvedChecks{EnvFiles: []string{envFile}, Jobs: []config.ResolvedJob{{Name: "test", Run: "make test"}}}
	h := newHarness(t, "none", cfg, nil)
	run := localRun()
	h.create(t, run, cfg)
	h.iso.jobs["test"] = func(_ context.Context, s isolation.Spec) (isolation.Result, error) {
		writeOut(s.Stderr, "token="+secret+"\nassertion failed\n")
		return isolation.Result{ExitCode: 3}, nil
	}

	if state := drive(t, h, run.ID); state != store.RunFailed {
		t.Fatalf("run = %s, want failed", state)
	}

	var failed *protocol.Event
	for _, ev := range frames[protocol.Event](t, h.st, store.KindEvent) {
		if ev.Job != nil && *ev.Job == "test" && string(ev.State) == string(store.JobFailed) {
			failed = &ev
		}
	}
	if failed == nil {
		t.Fatal("no failed event for job test")
	}
	jobs, err := h.st.Jobs(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || jobs[0].Reason != "exit 3" || jobs[0].ExitCode == nil || *jobs[0].ExitCode != 3 {
		t.Errorf("stored job = %+v, want reason exit 3 and exit code 3", jobs)
	}
	if want := []string{"token=***", "assertion failed"}; !slices.Equal(failed.Tail, want) {
		t.Errorf("tail = %q, want %q", failed.Tail, want)
	}
	log := readFile(t, logpipe.LogPath(h.runDir(run.ID).Root, "test"))
	if strings.Contains(log, secret) || !strings.Contains(log, "token=***") {
		t.Errorf("job log = %q, want the env_file value masked", log)
	}
}

func TestRunJobTimeoutBackstop(t *testing.T) {
	cfg := &config.ResolvedChecks{Jobs: []config.ResolvedJob{
		{Name: "hang", Run: "sleep 1000", Limits: config.ResolvedLimits{Timeout: 50 * time.Millisecond}},
		{Name: "reported", Run: "sleep 1000"},
	}}
	h := newHarness(t, "none", cfg, func(o *Options) { o.BackstopGrace = 50 * time.Millisecond })
	run := localRun()
	h.create(t, run, cfg)
	// A backend whose own timeout never fires: only the backstop ends it.
	h.iso.jobs["hang"] = func(ctx context.Context, _ isolation.Spec) (isolation.Result, error) {
		<-ctx.Done()
		return isolation.Result{ExitCode: -1}, ctx.Err()
	}
	h.iso.jobs["reported"] = func(context.Context, isolation.Spec) (isolation.Result, error) {
		return isolation.Result{ExitCode: -1, TimedOut: true}, nil
	}

	setUp(t, h, run)
	start := time.Now()
	out, err := h.ex.RunJob(context.Background(), run, job("hang"))
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("backstop took %v", elapsed)
	}
	if out.State != store.JobFailed || out.Reason != "timeout" {
		t.Errorf("backstop outcome = %+v, want failed timeout", out)
	}
	if got := h.iso.spec(t, "hang").Limits.Timeout; got != 50*time.Millisecond {
		t.Errorf("Spec timeout = %v, want 50ms", got)
	}

	out, err = h.ex.RunJob(context.Background(), run, job("reported"))
	if err != nil {
		t.Fatal(err)
	}
	if out.State != store.JobFailed || out.Reason != "timeout" {
		t.Errorf("backend timeout outcome = %+v, want failed timeout", out)
	}
	finish(t, h, run, store.RunFailed)
}

func TestRunJobCancelled(t *testing.T) {
	cfg := &config.ResolvedChecks{Jobs: []config.ResolvedJob{{Name: "wait", Run: "sleep 1000"}, {Name: "stopped", Run: "true"}}}
	h := newHarness(t, "none", cfg, nil)
	run := localRun()
	h.create(t, run, cfg)
	started := make(chan struct{})
	h.iso.jobs["wait"] = func(ctx context.Context, _ isolation.Spec) (isolation.Result, error) {
		close(started)
		<-ctx.Done()
		return isolation.Result{ExitCode: -1}, ctx.Err()
	}
	h.iso.jobs["stopped"] = func(context.Context, isolation.Spec) (isolation.Result, error) {
		return isolation.Result{ExitCode: -1, Cancelled: true}, nil
	}

	setUp(t, h, run)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-started
		cancel()
	}()
	out, err := h.ex.RunJob(ctx, run, job("wait"))
	if err != nil {
		t.Fatal(err)
	}
	if out.State != store.JobCancelled || out.Reason != "cancelled" {
		t.Errorf("ctx cancel outcome = %+v, want cancelled", out)
	}

	out, err = h.ex.RunJob(context.Background(), run, job("stopped"))
	if err != nil {
		t.Fatal(err)
	}
	if out.State != store.JobCancelled {
		t.Errorf("backend cancel outcome = %+v, want cancelled", out)
	}
	finish(t, h, run, store.RunCancelled)
}

func TestRunJobAnnotations(t *testing.T) {
	cfg := &config.ResolvedChecks{Jobs: []config.ResolvedJob{{Name: "lint", Run: "npx eslint .", Annotate: "eslint"}}}
	h := newHarness(t, "none", cfg, nil)
	run := localRun()
	h.create(t, run, cfg)
	h.iso.jobs["lint"] = func(_ context.Context, s isolation.Spec) (isolation.Result, error) {
		writeOut(s.Stdout, "\n"+filepath.Join(s.Dir, "app", "index.js")+"\n"+
			"  1:10  error  'foo' is defined but never used  no-unused-vars\n\n1 problem\n")
		return isolation.Result{ExitCode: 1}, nil
	}

	setUp(t, h, run)
	if _, err := h.ex.RunJob(context.Background(), run, job("lint")); err != nil {
		t.Fatal(err)
	}
	finish(t, h, run, store.RunFailed)

	got := frames[protocol.Annotations](t, h.st, store.KindAnnotations)
	if len(got) != 1 {
		t.Fatalf("annotations frames = %d, want 1", len(got))
	}
	a := got[0]
	if a.Job != "lint" || a.RunId != run.ID || len(a.Items) != 1 || a.Total == nil || *a.Total != 1 {
		t.Fatalf("frame = %+v", a)
	}
	it := a.Items[0]
	if it.Path != "app/index.js" || it.Line != 1 || it.Level != "failure" || it.Title == nil || *it.Title != "no-unused-vars" {
		t.Errorf("item = %+v", it)
	}
}

// Past logpipe.MaxAnnotations the frame carries the cap's worth of items and
// the true total, so a sink can say how many were left out.
func TestRunJobAnnotationsTotal(t *testing.T) {
	cfg := &config.ResolvedChecks{Jobs: []config.ResolvedJob{{Name: "lint", Run: "npx eslint .", Annotate: "eslint"}}}
	h := newHarness(t, "none", cfg, nil)
	run := localRun()
	h.create(t, run, cfg)
	const found = logpipe.MaxAnnotations + 7
	h.iso.jobs["lint"] = func(_ context.Context, s isolation.Spec) (isolation.Result, error) {
		var b strings.Builder
		b.WriteString("\n" + filepath.Join(s.Dir, "app", "index.js") + "\n")
		for i := range found {
			fmt.Fprintf(&b, "  %d:10  error  'foo' is defined but never used  no-unused-vars\n", i+1)
		}
		writeOut(s.Stdout, b.String())
		return isolation.Result{ExitCode: 1}, nil
	}

	setUp(t, h, run)
	if _, err := h.ex.RunJob(context.Background(), run, job("lint")); err != nil {
		t.Fatal(err)
	}
	finish(t, h, run, store.RunFailed)

	got := frames[protocol.Annotations](t, h.st, store.KindAnnotations)
	if len(got) != 1 || len(got[0].Items) != logpipe.MaxAnnotations || got[0].Total == nil || *got[0].Total != found {
		t.Fatalf("frames = %+v, want one with %d items and total %d", got, logpipe.MaxAnnotations, found)
	}
}

func TestSetupEgressDecisionsLogged(t *testing.T) {
	cfg := &config.ResolvedChecks{Egress: []string{"registry.npmjs.org"}, Jobs: []config.ResolvedJob{{Name: "build", Run: "npm ci"}}}
	h := newHarness(t, "systemd", cfg, nil)
	run := localRun()
	h.create(t, run, cfg)

	setUp(t, h, run)
	dir := h.runDir(run.ID)
	if want := []netnsSetup{{netns.ModeNetns, 4321, filepath.Join(dir.Root, "pasta.pid")}}; !slices.Equal(h.netns.setups, want) {
		t.Errorf("netns setups = %+v, want %+v", h.netns.setups, want)
	}
	if h.proxy.opts.RunID != run.ID || h.proxy.opts.Allow == nil || h.proxy.opts.OnDecision == nil {
		t.Fatalf("proxy options = %+v", h.proxy.opts)
	}
	h.proxy.opts.OnDecision(egress.Decision{Host: "evil.example", Port: 443, Reason: "not-allowlisted"})
	h.proxy.opts.OnDecision(egress.Decision{Host: "registry.npmjs.org", Port: 443, Allowed: true, Reason: "allowed"})

	if _, err := h.ex.RunJob(context.Background(), run, job("build")); err != nil {
		t.Fatal(err)
	}
	s := h.iso.spec(t, "build")
	if s.NetNSPath != "/run/netns/"+netns.NSName(run.ID) {
		t.Errorf("NetNSPath = %q", s.NetNSPath)
	}
	for _, kv := range []string{"HTTPS_PROXY=http://127.0.0.1:3128", "PATH=" + JobPATH} {
		if !hasEnv(s.Env, kv) {
			t.Errorf("env lacks %s: %q", kv, s.Env)
		}
	}
	finish(t, h, run, store.RunSuccess)

	log := readFile(t, logpipe.LogPath(dir.Root, "setup"))
	for _, line := range []string{"egress deny evil.example not-allowlisted\n", "egress allow registry.npmjs.org allowed\n"} {
		if !strings.Contains(log, line) {
			t.Errorf("setup.log lacks %q:\n%s", line, log)
		}
	}
}

func TestSetupNetworkFallbacks(t *testing.T) {
	cfg := &config.ResolvedChecks{Jobs: []config.ResolvedJob{{Name: "build", Run: "true"}}}

	h := newHarness(t, "systemd", cfg, nil)
	h.netns.available = false
	run := localRun()
	run.TrustDomain = "untrusted:local/app"
	err := h.ex.RunSetup(context.Background(), run)
	if !errors.Is(err, ErrSetupFailed) || !errors.Is(err, netns.ErrNetnsRequired) {
		t.Errorf("untrusted without netns: err = %v, want ErrSetupFailed wrapping ErrNetnsRequired", err)
	}
	finish(t, h, run, store.RunFailed)
	if slices.Contains(h.rec.list(), "proxy start") {
		t.Error("proxy started for a refused run")
	}

	h = newHarness(t, "systemd", cfg, nil)
	h.netns.available = false
	run = localRun()
	setUp(t, h, run)
	if _, err := h.ex.RunJob(context.Background(), run, job("build")); err != nil {
		t.Fatal(err)
	}
	finish(t, h, run, store.RunSuccess)
	if s := h.iso.spec(t, "build"); s.NetNSPath != "" || slices.ContainsFunc(s.Env, func(kv string) bool { return strings.HasPrefix(kv, "HTTPS_PROXY=") }) {
		t.Errorf("deny mode spec has a namespace or proxy: %+v", s)
	}
	if slices.Contains(h.rec.list(), "proxy start") {
		t.Error("deny mode started a proxy")
	}
	if log := readFile(t, logpipe.LogPath(h.runDir(run.ID).Root, "setup")); !strings.Contains(log, "network: pasta or ip is not available") {
		t.Errorf("setup.log lacks the deny fallback warning:\n%s", log)
	}
}

func TestRunPolicyEgressProxyOnly(t *testing.T) {
	const secret = "s3cr3t-token-value-123"
	envFile := filepath.Join(t.TempDir(), "prod.env")
	if err := os.WriteFile(envFile, []byte("API_TOKEN="+secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.ResolvedChecks{EnvFiles: []string{envFile}, Jobs: []config.ResolvedJob{{Name: "build", Run: "true"}}}
	untrusted := func(o *Options) { o.Policy = RunPolicy{EgressProxyOnly: true} }

	// Namespace: the proxy is the only way out and every proxy variable is set.
	h := newHarness(t, "systemd", cfg, untrusted)
	run := localRun()
	h.create(t, run, cfg)
	setUp(t, h, run)
	if _, err := h.ex.RunJob(context.Background(), run, job("build")); err != nil {
		t.Fatal(err)
	}
	finish(t, h, run, store.RunSuccess)
	if want := []netnsSetup{{netns.ModeNetns, 4321, filepath.Join(h.runDir(run.ID).Root, "pasta.pid")}}; !slices.Equal(h.netns.setups, want) {
		t.Errorf("netns setups = %+v, want %+v", h.netns.setups, want)
	}
	s := h.iso.spec(t, "build")
	for _, kv := range []string{"HTTPS_PROXY=http://127.0.0.1:3128", "ALL_PROXY=http://127.0.0.1:3128", "all_proxy=http://127.0.0.1:3128"} {
		if !hasEnv(s.Env, kv) {
			t.Errorf("env lacks %s: %q", kv, s.Env)
		}
	}
	if slices.ContainsFunc(s.Env, func(kv string) bool { return strings.Contains(kv, secret) }) {
		t.Errorf("job env carries a secret: %q", s.Env)
	}

	// No namespace: refused rather than falling back to deny mode, which
	// has no proxy.
	h = newHarness(t, "systemd", cfg, untrusted)
	h.netns.available = false
	run = localRun()
	err := h.ex.RunSetup(context.Background(), run)
	if !errors.Is(err, ErrSetupFailed) || !errors.Is(err, netns.ErrNetnsRequired) {
		t.Errorf("proxy only without netns: err = %v, want ErrSetupFailed wrapping ErrNetnsRequired", err)
	}
	finish(t, h, run, store.RunFailed)
	if slices.Contains(h.rec.list(), "proxy start") {
		t.Error("proxy started for a refused run")
	}

	// Isolation none: the variables are set and the open host network is
	// logged.
	h = newHarness(t, "none", cfg, untrusted)
	run = localRun()
	h.create(t, run, cfg)
	setUp(t, h, run)
	if _, err := h.ex.RunJob(context.Background(), run, job("build")); err != nil {
		t.Fatal(err)
	}
	finish(t, h, run, store.RunSuccess)
	if s := h.iso.spec(t, "build"); !hasEnv(s.Env, "ALL_PROXY=http://127.0.0.1:4321") {
		t.Errorf("env lacks ALL_PROXY: %q", s.Env)
	}
	if log := readFile(t, logpipe.LogPath(h.runDir(run.ID).Root, "setup")); !strings.Contains(log, "direct egress is not blocked") {
		t.Errorf("setup.log lacks the host network warning:\n%s", log)
	}
}

func TestRunPolicyDeploy(t *testing.T) {
	cfg := &config.ResolvedChecks{Jobs: []config.ResolvedJob{{Name: "deploy", Run: "true"}}}
	run := localRun()
	run.Kind = kindDeploy

	for _, p := range []RunPolicy{{EgressProxyOnly: true}, {AllowDeploy: true}, {AllowSecrets: true}} {
		h := newHarness(t, "none", cfg, func(o *Options) { o.Policy = p })
		err := h.ex.RunSetup(context.Background(), run)
		if !errors.Is(err, ErrSetupFailed) || !errors.Is(err, ErrDeployNotAllowed) {
			t.Errorf("policy %+v: err = %v, want ErrSetupFailed wrapping ErrDeployNotAllowed", p, err)
		}
		finish(t, h, run, store.RunFailed)
		if len(h.src.reqs) != 0 {
			t.Errorf("policy %+v: refused deploy was checked out", p)
		}
	}

	h := newHarness(t, "none", cfg, func(o *Options) { o.Policy = RunPolicy{AllowSecrets: true, AllowDeploy: true} })
	setUp(t, h, run)
	finish(t, h, run, store.RunSuccess)
	if len(h.src.reqs) != 1 {
		t.Errorf("checkouts = %d, want 1", len(h.src.reqs))
	}
}

func TestTeardownOrder(t *testing.T) {
	ctx := context.Background()
	sha := strings.Repeat("a", 40)
	git := &execx.Fake{}
	git.On("git", nil, execx.FakeResponse{})
	g := source.Git{Runner: git}
	mirrors := source.NewMirrors(filepath.Join(t.TempDir(), "mirrors"), g)

	cfg := &config.ResolvedChecks{
		Setup:    []config.SetupStep{{Run: "npm ci", Cache: &config.SetupStepCache{Key: []string{"package-lock.json"}, Paths: []string{"node_modules", "~/.npm"}}}},
		Services: config.Services{Postgres: &config.PostgresService{Image: "postgres:16"}},
		Jobs:     []config.ResolvedJob{{Name: "build", Run: "make"}},
	}
	h := newHarness(t, "systemd", cfg, func(o *Options) { o.Mirrors = mirrors })
	run := store.Run{ID: "01run", Repo: "o/r", SHA: sha, Ref: "refs/heads/main", Event: "push", Kind: "check", TrustDomain: "trusted:o/r"}
	unit := isolation.UnitPrefix + "01run-build"
	h.iso.units = []isolation.Unit{{Name: unit, Active: "active"}}
	pgErr := errors.New("pg stuck")
	proxyErr := errors.New("proxy close failed")
	h.pg.stopErr = pgErr
	h.proxy.closeErr = proxyErr
	h.proxy.onClose = func() {
		if err := mirrors.GC(ctx, "o/r"); !errors.Is(err, source.ErrBusy) {
			h.rec.add("mirror released before proxy close")
		}
	}

	setUp(t, h, run)
	dir := h.runDir(run.ID)
	if !git.Called("git", g.Args("clone", "--shared", "--no-checkout", filepath.Join(mirrors.Root, "o__r.git"), dir.Src())...) {
		t.Errorf("no shared clone into src: %+v", git.Calls)
	}
	if h.pg.opts.RunDir != dir.Root || h.pg.opts.Image != "postgres:16" {
		t.Errorf("postgres options = %+v", h.pg.opts)
	}
	if _, err := h.ex.RunJob(ctx, run, job("build")); err != nil {
		t.Fatal(err)
	}
	if !hasEnv(h.iso.spec(t, "build").Env, "DATABASE_URL=postgres://hookci@localhost/hookci") {
		t.Error("job env lacks the postgres env")
	}
	before := len(h.rec.list())

	err := h.ex.FinishRun(ctx, run, store.RunSuccess)
	if !errors.Is(err, pgErr) || !errors.Is(err, proxyErr) {
		t.Errorf("FinishRun err = %v, want both joined", err)
	}
	want := []string{
		"stop " + unit,
		"cache save",
		"cache cleanup",
		"postgres stop",
		"netns teardown " + netns.NSName(run.ID),
		"proxy close",
	}
	if got := h.rec.list()[before:]; !slices.Equal(got, want) {
		t.Errorf("teardown = %q, want %q", got, want)
	}
	if want := []string{isolation.UnitPrefix + "01run-"}; !slices.Equal(h.iso.prefixes, want) {
		t.Errorf("ListUnits prefixes = %q, want %q", h.iso.prefixes, want)
	}
	if err := mirrors.GC(ctx, "o/r"); err != nil {
		t.Errorf("mirror still in use after teardown: %v", err)
	}
	for _, gone := range []string{dir.Tmp(), dir.PG()} {
		if _, err := os.Stat(gone); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s not removed: %v", gone, err)
		}
	}
	log := readFile(t, logpipe.LogPath(dir.Root, "setup"))
	for _, line := range []string{"teardown: stop postgres: pg stuck", "teardown: close egress proxy: proxy close failed"} {
		if !strings.Contains(log, line) {
			t.Errorf("setup.log lacks %q:\n%s", line, log)
		}
	}
	if _, err := h.ex.RunJob(ctx, run, job("build")); !errors.Is(err, ErrNoRun) {
		t.Errorf("RunJob after FinishRun: err = %v, want ErrNoRun", err)
	}
}

var cacheCfg = &config.ResolvedChecks{
	Setup: []config.SetupStep{{Run: "npm ci", Cache: &config.SetupStepCache{Key: []string{"package-lock.json"}, Paths: []string{"node_modules"}}}},
	Jobs:  []config.ResolvedJob{{Name: "build", Run: "make"}},
}

func TestCacheSaveGatedByPolicy(t *testing.T) {
	pr := 12
	for _, tc := range []struct {
		name  string
		run   store.Run
		final store.RunState
		tried []string
		saved []string
	}{
		{"untrusted pull request", store.Run{Event: "pull_request", PR: &pr, Ref: "refs/pull/12/head", TrustDomain: "untrusted:o/r"}, store.RunSuccess, []string{"pull/12", "main"}, nil},
		{"trusted pull request", store.Run{Event: "pull_request", PR: &pr, Ref: "refs/pull/12/head", TrustDomain: "trusted:o/r"}, store.RunSuccess, []string{"pull/12", "main"}, []string{"pull/12"}},
		{"untrusted push", store.Run{Event: "push", Ref: "refs/heads/main", TrustDomain: "untrusted:o/r"}, store.RunSuccess, []string{"main"}, nil},
		{"trusted push to the default branch", store.Run{Event: "push", Ref: "refs/heads/main", TrustDomain: "trusted:o/r"}, store.RunSuccess, []string{"main"}, []string{"main"}},
		{"trusted push to another branch", store.Run{Event: "push", Ref: "refs/heads/feature/x", TrustDomain: "trusted:o/r"}, store.RunSuccess, []string{"feature/x", "main"}, []string{"feature/x"}},
		{"failed trusted push", store.Run{Event: "push", Ref: "refs/heads/main", TrustDomain: "trusted:o/r"}, store.RunFailed, []string{"main"}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, "none", cacheCfg, func(o *Options) { o.CacheFallback = []string{"main"} })
			run := tc.run
			run.ID, run.Repo, run.SHA, run.Kind = "01run", "o/r", strings.Repeat("b", 40), "check"
			setUp(t, h, run)
			finish(t, h, run, tc.final)

			var tried []string
			for _, k := range h.cache.restored {
				tried = append(tried, k.Scope)
				if k.TrustDomain != run.TrustDomain || !slices.Equal(k.Paths, []string{"src/node_modules"}) {
					t.Errorf("key = %+v, want the run's trust domain and src/node_modules", k)
				}
			}
			if !slices.Equal(tried, tc.tried) {
				t.Errorf("restored from %q, want %q", tried, tc.tried)
			}
			if !slices.Contains(h.rec.list(), "cache cleanup") {
				t.Error("restore cleanup did not run")
			}
			var saved []string
			for _, k := range h.cache.savedKeys {
				saved = append(saved, k.Scope)
			}
			if !slices.Equal(saved, tc.saved) {
				t.Fatalf("saved under %q, want %q", saved, tc.saved)
			}
			if len(tc.saved) > 0 {
				want := cache.Policy{Kind: "check", Event: run.Event, Trusted: true}
				if h.cache.saved[0] != want {
					t.Errorf("policy = %+v, want %+v", h.cache.saved[0], want)
				}
			}
		})
	}
}

// cacheRun drives a successful run on a fresh Executor over c with
// fallback, as the daemon builds one per run. It returns the scopes Restore
// tried in order, the one that hit ("" for none) and the scopes saved.
func cacheRun(t *testing.T, c *fakeCache, run store.Run, fallback []string) (tried []string, hit string, saved []string) {
	t.Helper()
	h := newHarness(t, "none", cacheCfg, func(o *Options) {
		o.Hooks.Cache = c
		o.CacheFallback = fallback
	})
	c.rec = h.rec
	r0, s0 := len(c.restored), len(c.savedKeys)
	run.ID, run.Repo, run.SHA, run.Kind = "01run", "o/r", strings.Repeat("b", 40), "check"
	setUp(t, h, run)
	finish(t, h, run, store.RunSuccess)
	for _, k := range c.restored[r0:] {
		tried = append(tried, k.Scope)
		if slices.ContainsFunc(c.savedKeys[:s0], func(s cache.Key) bool { return s.Hash == k.Hash }) {
			hit = k.Scope
		}
	}
	for _, k := range c.savedKeys[s0:] {
		saved = append(saved, k.Scope)
	}
	return tried, hit, saved
}

// Caches are per branch, as on GitHub Actions: a run reads its own branch,
// then the fallbacks it was given, and writes only its own branch, and only
// when no fallback's entry hit.
func TestCacheScopesAcrossBranches(t *testing.T) {
	c := &fakeCache{}
	push := func(branch string) store.Run {
		return store.Run{Event: "push", Ref: "refs/heads/" + branch, TrustDomain: "trusted:o/r"}
	}
	pr := 7
	pull := store.Run{Event: "pull_request", PR: &pr, Ref: "refs/pull/7/head", TrustDomain: "trusted:o/r"}
	for _, step := range []struct {
		name     string
		run      store.Run
		fallback []string
		tried    []string
		hit      string
		saved    []string
	}{
		{"first push to a branch saves under it", push("feature/a"), []string{"main"}, []string{"feature/a", "main"}, "", []string{"feature/a"}},
		{"another branch does not see it", push("feature/b"), []string{"main"}, []string{"feature/b", "main"}, "", []string{"feature/b"}},
		{"a fallback hit is not saved again under the branch", push("feature/c"), []string{"feature/a", "main"}, []string{"feature/c", "feature/a"}, "feature/a", nil},
		{"a fallback miss still saves under the branch", push("feature/d"), []string{"feature/x", "main"}, []string{"feature/d", "feature/x", "main"}, "", []string{"feature/d"}},
		{"default branch saves under itself", push("main"), []string{"main"}, []string{"main"}, "", []string{"main"}},
		{"own branch beats the default", push("feature/b"), []string{"main"}, []string{"feature/b"}, "feature/b", []string{"feature/b"}},
		{"pull request reads its base first", pull, []string{"feature/a", "main"}, []string{"pull/7", "feature/a"}, "feature/a", nil},
		{"pull request falls back to the default", pull, []string{"release", "main"}, []string{"pull/7", "release", "main"}, "main", nil},
		{"pull request miss saves under its own scope", pull, []string{"release", "other"}, []string{"pull/7", "release", "other"}, "", []string{"pull/7"}},
		{"pull request reads its own scope first", pull, []string{"main"}, []string{"pull/7"}, "pull/7", []string{"pull/7"}},
		{"untrusted push never reads trusted entries", store.Run{Event: "push", Ref: "refs/heads/main", TrustDomain: "untrusted:o/r"}, []string{"main"}, []string{"main"}, "", nil},
	} {
		tried, hit, saved := cacheRun(t, c, step.run, step.fallback)
		if !slices.Equal(tried, step.tried) || hit != step.hit || !slices.Equal(saved, step.saved) {
			t.Errorf("%s: tried %q, hit %q, saved %q; want %q, %q, %q", step.name, tried, hit, saved, step.tried, step.hit, step.saved)
		}
	}
	for _, k := range c.restored[len(c.restored)-1:] {
		if k.TrustDomain != "untrusted:o/r" {
			t.Errorf("untrusted run looked up %+v", k)
		}
	}
}

// A GitHub repo "local/app" must not share a cache with the local run of a
// directory named app, though both have trust domain "trusted:local/app".
func TestLocalRunCacheApartFromGitHubLocalOwner(t *testing.T) {
	cfg := &config.ResolvedChecks{
		Setup: []config.SetupStep{{Run: "npm ci", Cache: &config.SetupStepCache{Key: []string{"package-lock.json"}, Paths: []string{"node_modules"}}}},
		Jobs:  []config.ResolvedJob{{Name: "build", Run: "make"}},
	}
	h := newHarness(t, "none", cfg, nil)
	run := localRun()
	setUp(t, h, run)
	finish(t, h, run, store.RunSuccess)
	if len(h.cache.restored) != 1 {
		t.Fatalf("restores = %d, want 1", len(h.cache.restored))
	}
	local := h.cache.restored[0]

	c, err := cache.New(cache.Options{Root: t.TempDir(), Mode: cache.ModeCopy, Logger: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	wd := t.TempDir()
	if err := os.MkdirAll(filepath.Join(wd, "src", "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	github, err := cache.ComputeKey("trusted:local/app", local.Scope, local.Platform, wd, []string{"src/package-lock.json"}, local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(github.FileHashes, local.FileHashes) || !slices.Equal(github.Paths, local.Paths) {
		t.Fatalf("keys differ beyond the trust domain: %+v vs %+v", github, local)
	}
	if err := c.Save(context.Background(), github, cache.Policy{Kind: "check", Event: "push", Trusted: true}, wd); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		k    cache.Key
		hit  bool
	}{{"GitHub local/app", github, true}, {"local app", local, false}} {
		hit, cleanup, err := c.Restore(context.Background(), tc.k, t.TempDir())
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if cleanup != nil {
			cleanup()
		}
		if hit != tc.hit {
			t.Errorf("%s restore hit = %v, want %v", tc.name, hit, tc.hit)
		}
	}
}

func TestSetupFailureMarksRunFailed(t *testing.T) {
	cfg := &config.ResolvedChecks{
		Setup:    []config.SetupStep{{Run: "npm ci"}},
		Services: config.Services{Postgres: &config.PostgresService{Image: "postgres:16"}},
		Jobs:     []config.ResolvedJob{{Name: "build", Run: "make"}},
	}
	h := newHarness(t, "none", cfg, nil)
	run := localRun()
	h.create(t, run, cfg)
	h.iso.jobs["setup"] = func(_ context.Context, s isolation.Spec) (isolation.Result, error) {
		writeOut(s.Stderr, "npm ERR! missing lockfile\n")
		return isolation.Result{ExitCode: 1}, nil
	}

	if state := drive(t, h, run.ID); state != store.RunFailed {
		t.Fatalf("run = %s, want failed", state)
	}
	stored, err := h.st.GetRun(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Reason != "setup failed: setup[0] exit 1" {
		t.Errorf("run reason = %q, want %q", stored.Reason, "setup failed: setup[0] exit 1")
	}
	h.iso.mu.Lock()
	for _, s := range h.iso.specs {
		if s.Job != "setup" {
			t.Errorf("job %s ran after setup failed", s.Job)
		}
	}
	h.iso.mu.Unlock()
	calls := h.rec.list()
	for _, c := range []string{"postgres stop", "proxy close"} {
		if !slices.Contains(calls, c) {
			t.Errorf("teardown step %q did not run: %q", c, calls)
		}
	}
	log := readFile(t, logpipe.LogPath(h.runDir(run.ID).Root, "setup"))
	for _, s := range []string{"npm ERR! missing lockfile", "setup failed: setup[0] exit 1"} {
		if !strings.Contains(log, s) {
			t.Errorf("setup.log lacks %q:\n%s", s, log)
		}
	}

	h = newHarness(t, "none", cfg, nil)
	h.cfgErr = errors.New("hookci.yml: bad")
	err = h.ex.RunSetup(context.Background(), run)
	if !errors.Is(err, ErrSetupFailed) || !strings.Contains(err.Error(), "hookci.yml: bad") {
		t.Errorf("config error: err = %v, want ErrSetupFailed with the cause", err)
	}
	finish(t, h, run, store.RunFailed)
}

func TestSetupEmitsStageEventsAndTimings(t *testing.T) {
	cfg := &config.ResolvedChecks{
		Setup: []config.SetupStep{{Run: "npm ci\nnpm rebuild"}},
		Jobs:  []config.ResolvedJob{{Name: "build", Run: "make"}},
	}
	h := newHarness(t, "none", cfg, nil)
	run := localRun()
	h.create(t, run, cfg)
	setUp(t, h, run)

	items, err := h.st.Pending(context.Background(), 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, it := range items {
		var ev protocol.Event
		if err := json.Unmarshal(it.Payload, &ev); err != nil {
			t.Fatal(err)
		}
		if ev.Job != nil || ev.Step == nil || ev.StepIndex == nil {
			continue
		}
		total := 0
		if ev.StepsTotal != nil {
			total = *ev.StepsTotal
		}
		got = append(got, fmt.Sprintf("%d/%d %s", *ev.StepIndex, total, *ev.Step))
	}
	want := []string{
		"0/0 Checking out", "1/0 Reading config", "2/5 Starting network", "3/5 Restoring caches and starting services",
		"4/5 Setup step 1: npm ci",
	}
	if !slices.Equal(got, want) {
		t.Errorf("stage events = %q, want %q", got, want)
	}
	log := readFile(t, logpipe.LogPath(h.runDir(run.ID).Root, "setup"))
	for _, s := range []string{`stage "Checking out" took`, `stage "Setup step 1: npm ci" took`} {
		if !strings.Contains(log, s) {
			t.Errorf("setup.log lacks %q:\n%s", s, log)
		}
	}
}

// A setup error that quotes a secret, as docker's stderr can, must reach the
// stored run and job reasons and the setup log masked.
func TestSetupErrorRedacted(t *testing.T) {
	const secret = "s3cr3t-token-value-123"
	envFile := filepath.Join(t.TempDir(), "prod.env")
	if err := os.WriteFile(envFile, []byte("API_TOKEN="+secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.ResolvedChecks{
		EnvFiles: []string{envFile},
		Services: config.Services{Postgres: &config.PostgresService{Image: "postgres:16"}},
		Jobs:     []config.ResolvedJob{{Name: "build", Run: "make"}},
	}
	h := newHarness(t, "none", cfg, func(o *Options) {
		o.Hooks.StartPostgres = func(context.Context, services.PostgresOptions) (Postgres, error) {
			return nil, errors.New("docker run: invalid env API_TOKEN=" + secret)
		}
	})
	run := localRun()
	h.create(t, run, cfg)

	if state := drive(t, h, run.ID); state != store.RunFailed {
		t.Fatalf("run = %s, want failed", state)
	}
	stored, err := h.st.GetRun(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if want := "setup failed: postgres: docker run: invalid env API_TOKEN=" + redact.Mask; stored.Reason != want {
		t.Errorf("run reason = %q, want %q", stored.Reason, want)
	}
	jobs, err := h.st.Jobs(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || jobs[0].Reason != stored.Reason {
		t.Errorf("jobs = %+v, want build skipped with the run reason", jobs)
	}
	if log := readFile(t, logpipe.LogPath(h.runDir(run.ID).Root, "setup")); strings.Contains(log, secret) {
		t.Errorf("setup.log holds the secret:\n%s", log)
	}
}

// Under systemd jobs run as the job user, so the agent clones the run out
// without sharing the mirror, then hands the checkout and the dirs jobs
// write to the job user.
func TestSetupHandsRunDirToJobUser(t *testing.T) {
	git := &execx.Fake{}
	git.On("git", nil, execx.FakeResponse{})
	g := source.Git{Runner: git}
	mirrors := source.NewMirrors(filepath.Join(t.TempDir(), "mirrors"), g)
	var srcChowns []chownCall
	mirrors.Chown = recordChown(&srcChowns)
	cfg := &config.ResolvedChecks{Jobs: []config.ResolvedJob{{Name: "build", Run: "make"}}}
	cred := selfCred()
	var chowns []chownCall
	h := newHarness(t, "systemd", cfg, func(o *Options) {
		o.Mirrors = mirrors
		o.JobUser = JobUser{Cred: cred, Chown: recordChown(&chowns)}
	})

	mirrored := store.Run{ID: "01run", Repo: "o/r", SHA: strings.Repeat("a", 40), Ref: "refs/heads/main", Event: "push", Kind: "check", TrustDomain: "trusted:o/r"}
	setUp(t, h, mirrored)
	finish(t, h, mirrored, store.RunSuccess)
	dir := h.runDir(mirrored.ID)
	if len(git.Calls) != 2 || !slices.Equal(git.Calls[0].Args, g.Args("clone", "--no-hardlinks", "--no-checkout", filepath.Join(mirrors.Root, "o__r.git"), dir.Src())) {
		t.Fatalf("git calls = %+v, want a copying clone and checkout", git.Calls)
	}
	for _, c := range git.Calls {
		if c.Credential != nil {
			t.Errorf("git %q ran as %v, want the agent: the job user cannot read the mirror", c.Args, c.Credential)
		}
	}
	uid, gid := int(cred.Uid), int(cred.Gid)
	if want := []chownCall{{dir.Src(), uid, gid}}; !slices.Equal(srcChowns, want) {
		t.Errorf("checkout chown calls = %+v, want %+v", srcChowns, want)
	}
	if want := []chownCall{{dir.Src(), uid, gid}, {dir.Home(), uid, gid}, {dir.Tmp(), uid, gid}}; !slices.Equal(chowns, want) {
		t.Errorf("chown calls = %+v, want %+v", chowns, want)
	}

	local := localRun()
	local.ID = "02run"
	setUp(t, h, local)
	finish(t, h, local, store.RunSuccess)
	if len(h.src.reqs) != 1 || h.src.reqs[0].RunAs != cred {
		t.Errorf("local checkout requests = %+v, want one as the job user", h.src.reqs)
	}
	if h.src.released != 1 {
		t.Errorf("local checkout released %d times, want once at teardown", h.src.released)
	}
}
