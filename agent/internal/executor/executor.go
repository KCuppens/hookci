package executor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/cache"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/egress"
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
	Services       *services.Manager
	Cache          *cache.Manager
	Secrets        []string
	Slots          int
	DefaultTimeout time.Duration
}

// Executor orchestrates run setup, dependencies, isolation, logs, timeouts, and scheduler.
type Executor struct {
	stateDir       string
	store          *store.Store
	isolation      isolation.Isolation
	services       *services.Manager
	cache          *cache.Manager
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
		services:       opts.Services,
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
	domain egress.TrustDomain,
	isProtected bool,
) error {
	if cfg == nil || cfg.ZeroCIConfig.Checks == nil {
		return fmt.Errorf("config has no checks")
	}
	r := &runRunner{
		e:           e,
		checks:      cfg.ZeroCIConfig.Checks,
		workDir:     workDir,
		domain:      domain,
		isProtected: isProtected,
		redactor:    redact.New(e.secrets...),
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
// and services need no lock.
type runRunner struct {
	e           *Executor
	checks      *config.Checks
	workDir     string
	domain      egress.TrustDomain
	isProtected bool
	redactor    *redact.Redactor

	serviceEnv []string
	services   []*services.Service
}

// RunSetup starts services, restores setup step caches and runs the setup steps.
func (r *runRunner) RunSetup(ctx context.Context, run store.Run) error {
	e, checks := r.e, r.checks
	if e.services != nil && checks.Services != nil && checks.Services.Postgres != nil {
		serviceDir := filepath.Join(e.stateDir, "runs", run.ID, "services")
		if err := os.MkdirAll(serviceDir, 0o755); err != nil {
			return fmt.Errorf("create service dir: %w", err)
		}
		svc, err := e.services.Start(ctx, run.ID, *checks.Services.Postgres, serviceDir)
		if err != nil {
			return fmt.Errorf("start service postgres: %w", err)
		}
		r.services = append(r.services, svc)
		for k, v := range svc.Env {
			r.serviceEnv = append(r.serviceEnv, fmt.Sprintf("%s=%s", k, v))
		}
	}

	if e.cache != nil {
		for _, step := range checks.Setup {
			if step.Cache == nil {
				continue
			}
			for _, p := range step.Cache.Paths {
				_, _ = e.cache.Restore(ctx, r.domain, cacheKey(step.Cache, p), filepath.Join(r.workDir, p))
			}
		}
	}

	if len(checks.Setup) == 0 {
		return nil
	}
	pipe, err := logpipe.New(logpipe.LogPath(e.stateDir, run.ID, "setup"), r.redactor)
	if err != nil {
		return fmt.Errorf("create setup logpipe: %w", err)
	}
	defer pipe.Close()
	for _, step := range checks.Setup {
		res, err := e.isolation.Run(ctx, isolation.Spec{
			RunID:          run.ID,
			JobName:        "setup",
			Command:        []string{"sh", "-c", step.Run},
			Dir:            r.workDir,
			Env:            r.serviceEnv,
			Stdout:         pipe,
			Stderr:         pipe,
			ReadWritePaths: []string{r.workDir},
			Timeout:        e.defaultTimeout,
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
	pipe, err := logpipe.New(logpipe.LogPath(e.stateDir, run.ID, job.Name), r.redactor)
	if err != nil {
		return scheduler.JobOutcome{}, fmt.Errorf("create job logpipe: %w", err)
	}
	defer pipe.Close()

	timeout := ParseTimeout(cj.Timeout, e.defaultTimeout)
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	res, err := e.isolation.Run(execCtx, isolation.Spec{
		RunID:          run.ID,
		JobName:        job.Name,
		Command:        []string{"sh", "-c", cj.Run},
		Dir:            r.workDir,
		Env:            r.serviceEnv,
		Stdout:         pipe,
		Stderr:         pipe,
		ReadWritePaths: []string{r.workDir},
		Timeout:        timeout,
	})
	switch {
	case ctx.Err() != nil:
		return scheduler.JobOutcome{State: store.JobCancelled, ExitCode: res.ExitCode, Reason: "cancelled"}, nil
	case errors.Is(execCtx.Err(), context.DeadlineExceeded):
		return scheduler.JobOutcome{State: store.JobFailed, ExitCode: res.ExitCode, Reason: "timeout"}, nil
	case err != nil:
		return scheduler.JobOutcome{State: store.JobFailed, ExitCode: res.ExitCode, Reason: err.Error()}, nil
	case res.ExitCode != 0:
		return scheduler.JobOutcome{State: store.JobFailed, ExitCode: res.ExitCode, Reason: "exit " + strconv.Itoa(res.ExitCode)}, nil
	default:
		return scheduler.JobOutcome{State: store.JobSuccess}, nil
	}
}

// FinishRun saves setup step caches when the run succeeded, then stops
// services and cleans up isolation resources.
func (r *runRunner) FinishRun(ctx context.Context, run store.Run, final store.RunState) error {
	e := r.e
	if final == store.RunSuccess && e.cache != nil {
		for _, step := range r.checks.Setup {
			if step.Cache == nil {
				continue
			}
			for _, p := range step.Cache.Paths {
				_ = e.cache.Save(ctx, r.domain, r.isProtected, cacheKey(step.Cache, p), filepath.Join(r.workDir, p))
			}
		}
	}
	if e.services != nil {
		for _, svc := range r.services {
			_ = e.services.Stop(ctx, run.ID, svc.Name)
		}
	}
	if e.isolation != nil {
		return e.isolation.Cleanup(ctx, run.ID)
	}
	return nil
}

// cacheKey names the cache entry for one path of a setup step cache. The key
// files are named, not hashed.
func cacheKey(c *config.SetupStepCache, path string) string {
	return strings.Join(c.Key, "+") + "/" + path
}
