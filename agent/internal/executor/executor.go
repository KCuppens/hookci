package executor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/cache"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/logpipe"
	"github.com/KCuppens/zerocideploy/agent/internal/redact"
	"github.com/KCuppens/zerocideploy/agent/internal/scheduler"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// DefaultJobTimeout is the default maximum execution duration for a single job (10 minutes).
const DefaultJobTimeout = 10 * time.Minute

// Options configures the Executor.
type Options struct {
	StateDir       string
	Store          *store.Store
	Isolation      isolation.Isolation
	Docker         *services.Docker // nil: postgres services are not started
	Cache          *cache.Cache
	Secrets        []string
	Slots          int
	DefaultTimeout time.Duration
}

// Executor orchestrates run setup, dependencies, isolation, logs, timeouts, and scheduler.
type Executor struct {
	stateDir       string
	store          *store.Store
	isolation      isolation.Isolation
	docker         *services.Docker
	cache          *cache.Cache
	secrets        []string
	slots          int
	defaultTimeout time.Duration
}

// New constructs an Executor.
func New(opts Options) *Executor {
	defTimeout := opts.DefaultTimeout
	if defTimeout <= 0 {
		defTimeout = DefaultJobTimeout
	}
	return &Executor{
		stateDir:       opts.StateDir,
		store:          opts.Store,
		isolation:      opts.Isolation,
		docker:         opts.Docker,
		cache:          opts.Cache,
		secrets:        opts.Secrets,
		slots:          opts.Slots,
		defaultTimeout: defTimeout,
	}
}

// ParseTimeout parses a timeout string (e.g. "10m", "300s", "300") or returns defaultVal if nil or empty.
func ParseTimeout(s *string, defaultVal time.Duration) time.Duration {
	if s == nil || strings.TrimSpace(*s) == "" {
		return defaultVal
	}
	raw := strings.TrimSpace(*s)
	// Try standard Go duration first (e.g. "10m", "300s", "1h")
	if d, err := time.ParseDuration(raw); err == nil && d > 0 {
		return d
	}
	// Try pure integer as seconds (e.g. "300")
	if sec, err := strconv.Atoi(raw); err == nil && sec > 0 {
		return time.Duration(sec) * time.Second
	}
	return defaultVal
}

// ExecuteRun drives one queued run through the scheduler: setup (services,
// cache restore, setup steps), the check DAG, then teardown. It returns an
// error unless the run ends in success. If ctx is cancelled the scheduler is
// closed, which records running work as interrupted.
func (e *Executor) ExecuteRun(
	ctx context.Context,
	runID string,
	cfg *config.Config,
	workDir string,
	isProtected bool,
) error {
	if cfg == nil || cfg.ZeroCIConfig.Checks == nil {
		return fmt.Errorf("config has no checks")
	}
	resolved := cfg.Checks()
	var patterns []*regexp.Regexp
	if resolved != nil {
		patterns = resolved.Redact
	}
	redactor, _ := redact.New(e.secrets, patterns)
	r := &runRunner{
		e:           e,
		checks:      cfg.ZeroCIConfig.Checks,
		resolved:    resolved,
		workDir:     workDir,
		isProtected: isProtected,
		redactor:    redactor,
	}
	sched := scheduler.New(e.store, r, scheduler.Options{Slots: e.slots})
	defer sched.Close()

	if _, err := sched.Submit(ctx, runID); err != nil {
		return err
	}
	final, err := sched.Wait(ctx, runID)
	if err != nil {
		if ctx.Err() != nil {
			_ = sched.Close()
		}
		return err
	}
	if final != store.RunSuccess {
		return fmt.Errorf("run %s ended %s", runID, final)
	}
	return nil
}

// runRunner is the scheduler.JobRunner for one run. The scheduler calls
// RunSetup before any RunJob and FinishRun after the last one, so serviceEnv
// and postgres need no lock.
type runRunner struct {
	e           *Executor
	checks      *config.Checks
	resolved    *config.ResolvedChecks // nil for a Config that did not come from Parse
	workDir     string
	isProtected bool
	redactor    *redact.Redactor

	serviceEnv []string
	postgres   *services.Postgres

	cacheKeys     []cache.Key    // computed before setup ran, saved on success
	cacheCleanups []func() error // undo the restores once the run's units are gone
}

// RunSetup starts services, restores setup step caches and runs the setup steps.
func (r *runRunner) RunSetup(ctx context.Context, run store.Run) error {
	e, checks := r.e, r.checks
	if e.docker != nil && r.resolved != nil && r.resolved.Services.Postgres != nil {
		pg := r.resolved.Services.Postgres
		p, err := services.StartPostgres(ctx, services.PostgresOptions{
			RunID:       run.ID,
			RunDir:      r.runDir(run.ID),
			Image:       pg.Image,
			Tmpfs:       pg.Tmpfs,
			CPUs:        r.resolved.Limits.CPUs,
			MemoryBytes: r.resolved.Limits.MemoryBytes,
			Docker:      *e.docker,
		})
		if err != nil {
			return fmt.Errorf("start service postgres: %w", err)
		}
		r.postgres = p
		r.serviceEnv = p.Env()
	}

	if e.cache != nil {
		platform := runtime.GOOS + "-" + runtime.GOARCH
		for _, step := range checks.Setup {
			if step.Cache == nil {
				continue
			}
			// The key is fixed before setup runs, so Save stores what this
			// lockfile produced even if setup rewrites it.
			k, err := cache.ComputeKey(run.TrustDomain, platform, r.workDir, step.Cache.Key, step.Cache.Paths)
			if err != nil {
				continue
			}
			r.cacheKeys = append(r.cacheKeys, k)
			if _, cleanup, err := e.cache.Restore(ctx, k, r.workDir); err == nil {
				r.cacheCleanups = append(r.cacheCleanups, cleanup)
			}
		}
	}

	if len(checks.Setup) == 0 {
		return nil
	}
	pipe, err := logpipe.New(logpipe.Options{RunDir: r.runDir(run.ID), Job: "setup", Redactor: r.redactor, Workdir: r.workDir})
	if err != nil {
		return fmt.Errorf("create setup logpipe: %w", err)
	}
	defer pipe.Close()
	for _, step := range checks.Setup {
		res, err := e.isolation.Run(ctx, isolation.Spec{
			RunID:          run.ID,
			Job:            "setup",
			Argv:           []string{"sh", "-c", step.Run},
			Dir:            r.workDir,
			Env:            r.jobEnv(),
			Limits:         isolation.Limits{Timeout: e.defaultTimeout},
			ReadWritePaths: []string{r.workDir},
			Stdout:         pipe.Stdout(),
			Stderr:         pipe.Stderr(),
		})
		if err != nil {
			return fmt.Errorf("setup execution error: %w", err)
		}
		if res.ExitCode != 0 {
			return fmt.Errorf("setup command failed with exit code %d: %s", res.ExitCode, step.Run)
		}
	}
	return nil
}

// RunJob runs one check job under its timeout.
func (r *runRunner) RunJob(ctx context.Context, run store.Run, job store.Job) (scheduler.JobOutcome, error) {
	e := r.e
	cj, ok := r.checks.Jobs[job.Name]
	if !ok {
		return scheduler.JobOutcome{}, fmt.Errorf("job %s is not in the config", job.Name)
	}
	annotate := ""
	if cj.Annotate != nil {
		annotate = string(*cj.Annotate)
	}
	pipe, err := logpipe.New(logpipe.Options{RunDir: r.runDir(run.ID), Job: job.Name, Redactor: r.redactor, Annotate: annotate, Workdir: r.workDir})
	if err != nil {
		return scheduler.JobOutcome{}, fmt.Errorf("create job logpipe: %w", err)
	}
	defer pipe.Close()

	timeout := ParseTimeout(cj.Timeout, e.defaultTimeout)
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	res, err := e.isolation.Run(execCtx, isolation.Spec{
		RunID:          run.ID,
		Job:            job.Name,
		Argv:           []string{"sh", "-c", cj.Run},
		Dir:            r.workDir,
		Env:            r.jobEnv(),
		Limits:         isolation.Limits{Timeout: timeout},
		ReadWritePaths: []string{r.workDir},
		Stdout:         pipe.Stdout(),
		Stderr:         pipe.Stderr(),
	})
	switch {
	case ctx.Err() != nil || res.Cancelled:
		return scheduler.JobOutcome{State: store.JobCancelled, ExitCode: res.ExitCode, Reason: "cancelled"}, nil
	case res.TimedOut || errors.Is(execCtx.Err(), context.DeadlineExceeded):
		return scheduler.JobOutcome{State: store.JobFailed, ExitCode: res.ExitCode, Reason: "timeout"}, nil
	case err != nil:
		return scheduler.JobOutcome{State: store.JobFailed, ExitCode: res.ExitCode, Reason: err.Error()}, nil
	case res.ExitCode != 0:
		return scheduler.JobOutcome{State: store.JobFailed, ExitCode: res.ExitCode, Reason: "exit " + strconv.Itoa(res.ExitCode)}, nil
	default:
		return scheduler.JobOutcome{State: store.JobSuccess}, nil
	}
}

func (r *runRunner) runDir(runID string) string {
	return filepath.Join(r.e.stateDir, "runs", runID)
}

// jobPATH is the PATH jobs get under systemd; the none backend keeps the
// agent's PATH so local toolchains still resolve.
const jobPATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// jobEnv is the whole job environment. Backends add nothing, so the job sees
// PATH, HOME and the service variables and never the agent's own env.
func (r *runRunner) jobEnv() []string {
	path, home := jobPATH, "/tmp" // /tmp is the unit's private, writable PrivateTmp
	if r.e.isolation.Name() == "none" {
		if p := os.Getenv("PATH"); p != "" {
			path = p
		}
		if h := os.Getenv("HOME"); h != "" {
			home = h
		}
	}
	return append([]string{"PATH=" + path, "HOME=" + home}, r.serviceEnv...)
}

// FinishRun saves setup step caches when the run succeeded and policy
// allows, stops services and any job units of the run still alive, then
// undoes the cache restores (overlay unmounts).
func (r *runRunner) FinishRun(ctx context.Context, run store.Run, final store.RunState) error {
	e := r.e
	if final == store.RunSuccess && e.cache != nil {
		policy := cache.Policy{
			Kind:      run.Kind,
			Event:     run.Event,
			Protected: r.isProtected,
			Trusted:   strings.HasPrefix(run.TrustDomain, "trusted:"),
		}
		for _, k := range r.cacheKeys {
			_ = e.cache.Save(ctx, k, policy, r.workDir)
		}
	}
	_ = r.postgres.Stop(ctx)
	var errs []error
	if e.isolation != nil {
		units, err := e.isolation.ListUnits(ctx, isolation.UnitPrefix+isolation.SanitizeUnitPart(run.ID)+"-")
		errs = append(errs, err)
		for _, u := range units {
			errs = append(errs, e.isolation.Stop(ctx, u.Name))
		}
	}
	for _, cleanup := range slices.Backward(r.cacheCleanups) {
		errs = append(errs, cleanup())
	}
	return errors.Join(errs...)
}
