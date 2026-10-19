// Package executor runs one run's setup, jobs and teardown for the
// scheduler: checkout, config, redaction, network namespace and egress
// proxy, caches, postgres, setup steps, job processes with their limits, and
// a teardown that always runs every step.
package executor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/cache"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/egress"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/logpipe"
	"github.com/KCuppens/zerocideploy/agent/internal/netns"
	"github.com/KCuppens/zerocideploy/agent/internal/redact"
	"github.com/KCuppens/zerocideploy/agent/internal/scheduler"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
	"github.com/KCuppens/zerocideploy/agent/internal/source"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

var (
	// ErrNoRun is returned by RunJob and FinishRun for a run RunSetup never saw.
	ErrNoRun = errors.New("executor: unknown run")
	// ErrSetupFailed wraps every RunSetup error.
	ErrSetupFailed = errors.New("executor: setup failed")
)

// setupJob is the log name of the setup phase: logs/setup.log.
const setupJob = "setup"

// defaultBackstopGrace is added to a job's timeout for the context deadline
// that catches a backend whose own timeout did not fire.
const defaultBackstopGrace = 30 * time.Second

// NetnsManager creates and removes a run's network namespace.
// *netns.Manager implements it.
type NetnsManager interface {
	Available() (bool, string)
	Setup(ctx context.Context, runID string, mode netns.Mode, hostProxyPort int, pidFile string) (*netns.Network, error)
	Teardown(ctx context.Context, n *netns.Network) error
}

// Proxy is a running egress proxy. *egress.Proxy implements it.
type Proxy interface {
	Port() int
	Close() error
}

// Postgres is a running postgres sidecar. *services.Postgres implements it.
type Postgres interface {
	Env() []string
	Stop(ctx context.Context) error
}

// Cache restores and saves setup step caches. *cache.Cache implements it.
type Cache interface {
	Restore(ctx context.Context, k cache.Key, workdir string) (hit bool, cleanup func() error, err error)
	Save(ctx context.Context, k cache.Key, p cache.Policy, workdir string) error
}

// Hooks are the executor's side effects outside isolation and source.
type Hooks struct {
	Netns         NetnsManager                                                      // nil: &netns.Manager{}
	StartProxy    func(context.Context, egress.Options) (Proxy, error)              // nil: egress.Start
	StartPostgres func(context.Context, services.PostgresOptions) (Postgres, error) // nil: services.StartPostgres
	Cache         Cache                                                             // nil: setup step caches are not restored or saved
}

// Options configures New.
type Options struct {
	StateDir  string
	Store     *store.Store
	Isolation isolation.Isolation
	// JobUser is who jobs run as: isolation.JobCredential under systemd,
	// which then owns the checkout, HOME and TMPDIR. Zero: the agent's user.
	JobUser JobUser
	Source  source.Source   // checkout of local/ repos, and of every repo when Mirrors is nil
	Mirrors *source.Mirrors // shared clones of mirrored repos; nil: Source checks out everything
	// Config loads the run's checks from its checked-out tree.
	Config func(run store.Run, workdir string) (*config.ResolvedChecks, error)
	// Protected reports whether the run's ref is a protected branch, which
	// lets a trusted push run save caches. nil: no ref is protected.
	Protected     func(run store.Run) bool
	Hooks         Hooks
	Clock         func() time.Time // default time.Now; given to services
	Logger        *slog.Logger     // default slog.Default()
	Mirror        io.Writer        // optional copy of every redacted log line, e.g. verbose CLI
	BackstopGrace time.Duration    // default 30s
}

// Executor implements scheduler.JobRunner. One Executor serves every run of
// an agent; per-run state lives between RunSetup and FinishRun.
type Executor struct {
	o Options

	mu   sync.Mutex
	runs map[string]*runState
}

var _ scheduler.JobRunner = (*Executor)(nil)

// runState is one run's setup results. RunSetup fills it before any RunJob,
// and FinishRun runs after the last RunJob, so jobs only read it.
type runState struct {
	run      store.Run // SHA is the checked-out commit
	dir      RunDir
	trusted  bool
	cfg      *config.ResolvedChecks
	redactor *redact.Redactor
	setupLog *logpipe.Pipe // executor lines: egress decisions, cache and teardown notes
	log      *slog.Logger

	release    func() // mirror shared-clone release
	proxy      Proxy
	network    *netns.Network
	proxyEnv   []string
	pg         Postgres
	serviceEnv []string
	cacheKeys  []cache.Key
	cleanups   []func() error
}

// New checks o and fills its defaults.
func New(o Options) (*Executor, error) {
	switch {
	case o.StateDir == "":
		return nil, errors.New("executor: StateDir is required")
	case o.Store == nil:
		return nil, errors.New("executor: Store is required")
	case o.Isolation == nil:
		return nil, errors.New("executor: Isolation is required")
	case o.Source == nil:
		return nil, errors.New("executor: Source is required")
	case o.Config == nil:
		return nil, errors.New("executor: Config is required")
	}
	if o.Hooks.Netns == nil {
		o.Hooks.Netns = &netns.Manager{}
	}
	if o.Hooks.StartProxy == nil {
		o.Hooks.StartProxy = startEgressProxy
	}
	if o.Hooks.StartPostgres == nil {
		o.Hooks.StartPostgres = startPostgres
	}
	if o.Clock == nil {
		o.Clock = time.Now
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.BackstopGrace <= 0 {
		o.BackstopGrace = defaultBackstopGrace
	}
	return &Executor{o: o, runs: map[string]*runState{}}, nil
}

func startEgressProxy(ctx context.Context, o egress.Options) (Proxy, error) {
	p, err := egress.Start(ctx, o)
	if err != nil {
		return nil, err
	}
	return p, nil
}

func startPostgres(ctx context.Context, o services.PostgresOptions) (Postgres, error) {
	p, err := services.StartPostgres(ctx, o)
	if err != nil {
		return nil, err
	}
	return p, nil
}

func (e *Executor) state(runID string) (*runState, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	rs, ok := e.runs[runID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNoRun, runID)
	}
	return rs, nil
}

// RunSetup checks the run out, loads its config, builds the redactor,
// network and egress proxy, restores caches, starts postgres and runs the
// setup steps. Every error wraps ErrSetupFailed and is written to
// logs/setup.log; whatever was started is released by FinishRun.
func (e *Executor) RunSetup(ctx context.Context, run store.Run) error {
	rs := &runState{
		run:     run,
		trusted: strings.HasPrefix(run.TrustDomain, "trusted:"),
		log:     e.o.Logger.With("run", run.ID),
	}
	e.mu.Lock()
	if _, dup := e.runs[run.ID]; dup {
		e.mu.Unlock()
		return fmt.Errorf("%w: run %s is already set up", ErrSetupFailed, run.ID)
	}
	e.runs[run.ID] = rs
	e.mu.Unlock()

	if err := e.setup(ctx, rs); err != nil {
		rs.logf("setup failed: %v", err)
		return fmt.Errorf("%w: %w", ErrSetupFailed, err)
	}
	return nil
}

func (e *Executor) setup(ctx context.Context, rs *runState) error {
	dir, err := NewRunDir(e.o.StateDir, rs.run.ID, e.o.JobUser)
	if err != nil {
		return err
	}
	rs.dir = dir
	// Until the config names the secrets, only the builtin patterns apply.
	if err := rs.openSetupLog(nil, e.o.Mirror); err != nil {
		return err
	}

	if err := e.checkout(ctx, rs); err != nil {
		return fmt.Errorf("checkout: %w", err)
	}

	cfg, err := e.o.Config(rs.run, dir.Src())
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if cfg == nil {
		return errors.New("config: no checks configured")
	}
	rs.cfg = cfg

	var literals []string
	for _, path := range cfg.EnvFiles {
		values, warnings, err := redact.LoadEnvFileValues(path)
		for _, w := range warnings {
			rs.logf("env_file %s: %s", path, w)
		}
		if err != nil {
			rs.logf("env_file %s: values not masked: %v", path, err)
			continue
		}
		literals = append(literals, values...)
	}
	r, warnings := redact.New(literals, cfg.Redact)
	rs.redactor = r
	if err := rs.openSetupLog(r, e.o.Mirror); err != nil {
		return err
	}
	for _, w := range warnings {
		rs.logf("redact: %s", w)
	}

	if err := e.startNetwork(ctx, rs); err != nil {
		return err
	}
	e.restoreCaches(ctx, rs)
	if err := e.startServices(ctx, rs); err != nil {
		return err
	}
	return e.runSetupSteps(ctx, rs)
}

// checkout materialises the run into Src() as the job user. Mirrored repos
// get a shared clone whose release FinishRun calls; local/ repos, and every
// repo when Mirrors is nil, go through Source.
func (e *Executor) checkout(ctx context.Context, rs *runState) error {
	run := rs.run
	if e.o.Mirrors != nil && !strings.HasPrefix(run.Repo, "local/") {
		release, err := e.o.Mirrors.CloneShared(ctx, run.Repo, run.SHA, rs.dir.Src(), e.o.JobUser.Cred)
		if err != nil {
			return err
		}
		rs.release = release
		rs.logf("checkout %s %s", run.Repo, run.SHA)
		return nil
	}
	co, err := e.o.Source.Checkout(ctx, source.Request{Repo: run.Repo, SHA: run.SHA, Ref: run.Ref, RunAs: e.o.JobUser.Cred}, rs.dir.Src())
	if err != nil {
		return err
	}
	if co.SHA != "" {
		rs.run.SHA = co.SHA
	}
	rs.logf("checkout %s %s", run.Repo, rs.run.SHA)
	return nil
}

// startNetwork decides the network mode and starts the egress proxy and,
// in netns mode, the namespace. Deny mode has no proxy: systemd's
// IPAddressDeny blocks all egress.
func (e *Executor) startNetwork(ctx context.Context, rs *runState) error {
	available, why := e.o.Hooks.Netns.Available()
	mode, warning, err := netns.Decide(e.o.Isolation.Name(), rs.trusted, available)
	if err != nil {
		if why != "" {
			return fmt.Errorf("%w (%s)", err, why)
		}
		return err
	}
	if warning != "" {
		rs.logf("network: %s", warning)
	}
	if mode == netns.ModeDeny {
		return nil
	}

	allow, warnings, err := egress.NewAllowList(rs.trusted, rs.cfg.Egress)
	if err != nil {
		return fmt.Errorf("egress: %w", err)
	}
	for _, w := range warnings {
		rs.logf("egress: %s", w)
	}
	// The proxy and pasta outlive setup; FinishRun stops them.
	long := context.WithoutCancel(ctx)
	proxy, err := e.o.Hooks.StartProxy(long, egress.Options{
		RunID: rs.run.ID,
		Allow: allow,
		OnDecision: func(d egress.Decision) {
			verdict := "deny"
			if d.Allowed {
				verdict = "allow"
			}
			rs.logf("egress %s %s %s", verdict, d.Host, d.Reason)
		},
	})
	if err != nil {
		return fmt.Errorf("egress proxy: %w", err)
	}
	rs.proxy = proxy
	if mode == netns.ModeHost {
		rs.proxyEnv = netns.ProxyEnv(proxy.Port())
		return nil
	}

	network, err := e.o.Hooks.Netns.Setup(long, rs.run.ID, mode, proxy.Port(), filepath.Join(rs.dir.Root, "pasta.pid"))
	if err != nil {
		return fmt.Errorf("network namespace: %w", err)
	}
	rs.network = network
	rs.proxyEnv = network.Env()
	return nil
}

// cachePath maps a setup cache path onto the run dir, the cache workdir:
// "~" and "~/x" are under home/, anything else is under src/.
func cachePath(p string) (string, error) {
	base, rest := "src", p
	switch {
	case p == "~":
		return "home", nil
	case strings.HasPrefix(p, "~/"):
		base, rest = "home", p[2:]
	}
	c := filepath.Clean(rest)
	if !filepath.IsLocal(c) || c == "." {
		return "", fmt.Errorf("cache path %q is not inside the %s directory", p, base)
	}
	return filepath.ToSlash(filepath.Join(base, c)), nil
}

func cachePaths(ps []string) ([]string, error) {
	out := make([]string, len(ps))
	for i, p := range ps {
		c, err := cachePath(p)
		if err != nil {
			return nil, err
		}
		out[i] = c
	}
	return out, nil
}

// restoreCaches computes each setup step's cache key before setup runs, so
// Save stores what this lockfile produced even if setup rewrites it, and
// restores it. Cache errors are logged and never fail the run.
func (e *Executor) restoreCaches(ctx context.Context, rs *runState) {
	if e.o.Hooks.Cache == nil {
		return
	}
	platform := runtime.GOOS + "-" + runtime.GOARCH
	for i, step := range rs.cfg.Setup {
		if step.Cache == nil {
			continue
		}
		keyFiles := make([]string, len(step.Cache.Key))
		for j, f := range step.Cache.Key {
			keyFiles[j] = filepath.ToSlash(filepath.Join("src", f))
		}
		paths, err := cachePaths(step.Cache.Paths)
		if err != nil {
			rs.logf("cache setup[%d]: %v", i, err)
			continue
		}
		k, err := cache.ComputeKey(rs.run.TrustDomain, platform, rs.dir.Root, keyFiles, paths)
		if err != nil {
			rs.logf("cache setup[%d]: key: %v", i, err)
			continue
		}
		rs.cacheKeys = append(rs.cacheKeys, k)
		hit, cleanup, err := e.o.Hooks.Cache.Restore(ctx, k, rs.dir.Root)
		if cleanup != nil {
			rs.cleanups = append(rs.cleanups, cleanup)
		}
		switch {
		case err != nil:
			rs.logf("cache setup[%d]: restore %s: %v", i, k.Hash, err)
		case hit:
			rs.logf("cache setup[%d]: hit %s", i, k.Hash)
		default:
			rs.logf("cache setup[%d]: miss %s", i, k.Hash)
		}
	}
}

// startServices starts postgres when configured. Its socket dir is PG().
func (e *Executor) startServices(ctx context.Context, rs *runState) error {
	pgc := rs.cfg.Services.Postgres
	if pgc == nil {
		return nil
	}
	lim := EffectiveLimits(rs.run, rs.cfg.Limits, config.ResolvedJob{})
	pg, err := e.o.Hooks.StartPostgres(ctx, services.PostgresOptions{
		RunID:       rs.run.ID,
		RunDir:      rs.dir.Root,
		Image:       pgc.Image,
		Tmpfs:       pgc.Tmpfs,
		CPUs:        lim.CPUs,
		MemoryBytes: lim.MemoryBytes,
		Clock:       e.o.Clock,
	})
	if err != nil {
		return fmt.Errorf("postgres: %w", err)
	}
	rs.pg = pg
	rs.serviceEnv = pg.Env()
	rs.logf("postgres started")
	return nil
}

// runSetupSteps runs setup[] in order under the check-level limits.
func (e *Executor) runSetupSteps(ctx context.Context, rs *runState) error {
	if len(rs.cfg.Setup) == 0 {
		return nil
	}
	pipe, err := logpipe.New(logpipe.Options{
		RunDir:   rs.dir.Root,
		Job:      setupJob,
		Redactor: rs.redactor,
		Workdir:  rs.dir.Src(),
		Mirror:   e.o.Mirror,
	})
	if err != nil {
		return err
	}
	defer pipe.Close()
	lim := EffectiveLimits(rs.run, rs.cfg.Limits, config.ResolvedJob{})
	for i, step := range rs.cfg.Setup {
		rs.logf("setup[%d]: %s", i, step.Run)
		out := e.execute(ctx, rs, setupJob, step.Run, lim, pipe)
		if out.State != store.JobSuccess {
			return fmt.Errorf("setup[%d] %s", i, out.Reason)
		}
	}
	return nil
}

// RunJob runs one job of a set-up run and maps the result to its outcome.
func (e *Executor) RunJob(ctx context.Context, run store.Run, job store.Job) (scheduler.JobOutcome, error) {
	rs, err := e.state(run.ID)
	if err != nil {
		return scheduler.JobOutcome{}, err
	}
	i := slices.IndexFunc(rs.cfg.Jobs, func(j config.ResolvedJob) bool { return j.Name == job.Name })
	if i < 0 {
		return scheduler.JobOutcome{}, fmt.Errorf("executor: job %s is not in the config", job.Name)
	}
	cj := rs.cfg.Jobs[i]

	pipe, err := logpipe.New(logpipe.Options{
		RunDir:   rs.dir.Root,
		Job:      job.Name,
		Redactor: rs.redactor,
		Annotate: cj.Annotate,
		Workdir:  rs.dir.Src(),
		OnStep: func(s logpipe.StepEvent) {
			if err := e.appendStep(context.WithoutCancel(ctx), run.ID, job.Name, s); err != nil {
				rs.log.Warn("executor: step event", "job", job.Name, "step", s.Name, "err", err)
			}
		},
		Mirror: e.o.Mirror,
	})
	if err != nil {
		return scheduler.JobOutcome{}, err
	}
	out := e.execute(ctx, rs, job.Name, cj.Run, EffectiveLimits(rs.run, rs.cfg.Limits, cj), pipe)
	if err := pipe.Close(); err != nil {
		rs.log.Warn("executor: close job log", "job", job.Name, "err", err)
	}
	out.Tail = pipe.Tail()
	items, truncated := pipe.Annotations()
	if truncated > 0 {
		rs.log.Info("executor: annotations truncated", "job", job.Name, "dropped", truncated)
	}
	if err := e.appendAnnotations(context.WithoutCancel(ctx), run.ID, job.Name, items); err != nil {
		rs.log.Warn("executor: annotations", "job", job.Name, "err", err)
	}
	return out, nil
}

// execute runs script under isolation with a backstop deadline of the
// timeout plus BackstopGrace, for a backend whose own timeout never fires.
func (e *Executor) execute(ctx context.Context, rs *runState, job, script string, lim isolation.Limits, pipe *logpipe.Pipe) scheduler.JobOutcome {
	runCtx := ctx
	if lim.Timeout > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, lim.Timeout+e.o.BackstopGrace)
		defer cancel()
	}
	var nsPath string
	if rs.network != nil {
		nsPath = rs.network.NSPath
	}
	res, err := e.o.Isolation.Run(runCtx, isolation.Spec{
		RunID: rs.run.ID,
		Job:   job,
		Argv:  []string{"/bin/sh", "-ec", script},
		Dir:   rs.dir.Src(),
		Env: BuildJobEnv(EnvInput{
			Run:         rs.run,
			Job:         job,
			Dir:         rs.dir,
			ProxyEnv:    rs.proxyEnv,
			ServiceEnv:  rs.serviceEnv,
			InheritPATH: e.o.Isolation.Name() == "none",
		}),
		Limits:         lim,
		NetNSPath:      nsPath,
		ReadWritePaths: []string{rs.dir.Src(), rs.dir.Home(), rs.dir.Tmp(), rs.dir.PG()},
		User:           isolation.DefaultUser,
		Stdout:         pipe.Stdout(),
		Stderr:         pipe.Stderr(),
	})
	failed := func(reason string) scheduler.JobOutcome {
		return scheduler.JobOutcome{State: store.JobFailed, ExitCode: res.ExitCode, Reason: reason}
	}
	switch {
	case ctx.Err() != nil || res.Cancelled:
		return scheduler.JobOutcome{State: store.JobCancelled, ExitCode: res.ExitCode, Reason: "cancelled"}
	case res.TimedOut || runCtx.Err() != nil:
		return failed("timeout")
	case err != nil:
		return failed(err.Error())
	case res.ExitCode != 0:
		return failed("exit " + strconv.Itoa(res.ExitCode))
	default:
		return scheduler.JobOutcome{State: store.JobSuccess, ExitCode: 0}
	}
}

// FinishRun tears the run down. Every step runs even when an earlier one
// failed; the errors are joined and each is written to logs/setup.log.
// Order: stop leftover units, save caches (run success and policy allows),
// undo cache restores, stop postgres, remove the namespace, close the
// proxy, release the mirror clone, remove tmp/ and pg/. logs/ is kept.
func (e *Executor) FinishRun(ctx context.Context, run store.Run, final store.RunState) error {
	rs, err := e.state(run.ID)
	if err != nil {
		return err
	}
	defer func() {
		e.mu.Lock()
		delete(e.runs, run.ID)
		e.mu.Unlock()
	}()

	var errs []error
	note := func(what string, err error) {
		if err != nil {
			err = fmt.Errorf("%s: %w", what, err)
			errs = append(errs, err)
			rs.logf("teardown: %v", err)
		}
	}

	iso := e.o.Isolation
	units, err := iso.ListUnits(ctx, isolation.UnitPrefix+isolation.SanitizeUnitPart(run.ID)+"-")
	note("list units", err)
	for _, u := range units {
		note("stop unit "+u.Name, iso.Stop(ctx, u.Name))
	}

	if final == store.RunSuccess && e.o.Hooks.Cache != nil && len(rs.cacheKeys) > 0 {
		policy := cache.Policy{Kind: run.Kind, Event: run.Event, Trusted: rs.trusted}
		if e.o.Protected != nil {
			policy.Protected = e.o.Protected(run)
		}
		if cache.MaySave(policy) {
			for _, k := range rs.cacheKeys {
				err := e.o.Hooks.Cache.Save(ctx, k, policy, rs.dir.Root)
				note("cache save "+k.Hash, err)
				if err == nil {
					rs.logf("cache saved %s", k.Hash)
				}
			}
		}
	}
	for _, cleanup := range slices.Backward(rs.cleanups) {
		note("cache cleanup", cleanup())
	}
	if rs.pg != nil {
		note("stop postgres", rs.pg.Stop(ctx))
	}
	if rs.network != nil {
		note("network namespace teardown", e.o.Hooks.Netns.Teardown(ctx, rs.network))
	}
	if rs.proxy != nil {
		note("close egress proxy", rs.proxy.Close())
	}
	if rs.release != nil {
		rs.release()
	}
	if rs.dir.Root != "" {
		note("remove tmp", os.RemoveAll(rs.dir.Tmp()))
		note("remove pg", os.RemoveAll(rs.dir.PG()))
	}
	if rs.setupLog != nil {
		if err := rs.setupLog.Close(); err != nil {
			errs = append(errs, fmt.Errorf("close setup log: %w", err))
		}
	}
	if err := errors.Join(errs...); err != nil {
		return fmt.Errorf("executor: teardown %s: %w", run.ID, err)
	}
	return nil
}

// openSetupLog (re)opens logs/setup.log with r. The file is appended to,
// so lines written before the redactor existed stay.
func (rs *runState) openSetupLog(r *redact.Redactor, mirror io.Writer) error {
	if rs.setupLog != nil {
		if err := rs.setupLog.Close(); err != nil {
			return err
		}
		rs.setupLog = nil
	}
	p, err := logpipe.New(logpipe.Options{RunDir: rs.dir.Root, Job: setupJob, Redactor: r, Mirror: mirror})
	if err != nil {
		return err
	}
	rs.setupLog = p
	return nil
}

// logf writes one executor line to logs/setup.log, or to the logger before
// the run dir exists. It is safe for concurrent use: the proxy calls it.
func (rs *runState) logf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	if rs.setupLog == nil {
		rs.log.Info("executor: " + line)
		return
	}
	if _, err := io.WriteString(rs.setupLog.Stderr(), line+"\n"); err != nil {
		rs.log.Warn("executor: setup log", "line", line, "err", err)
	}
}
