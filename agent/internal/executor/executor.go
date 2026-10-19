package executor

import (
	"context"
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
	Store          *store.DB
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
	store          *store.DB
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

// ExecuteRun orchestrates execution of an entire run: services, setup, cache restore, check DAG, and cleanup.
func (e *Executor) ExecuteRun(
	ctx context.Context,
	runID string,
	cfg *config.Config,
	workDir string,
	domain egress.TrustDomain,
	isProtected bool,
) error {
	if cfg == nil {
		return fmt.Errorf("config is nil")
	}

	// 1. Prepare run-level service directories and environment
	var (
		serviceEnv      []string
		runningServices []*services.Service
	)

	if e.services != nil && len(cfg.Services) > 0 {
		serviceDir := filepath.Join(e.stateDir, "runs", runID, "services")
		if err := os.MkdirAll(serviceDir, 0o755); err != nil {
			return fmt.Errorf("create service dir: %w", err)
		}

		for name, sCfg := range cfg.Services {
			svc, err := e.services.Start(ctx, runID, name, sCfg, serviceDir)
			if err != nil {
				return fmt.Errorf("start service %s: %w", name, err)
			}
			runningServices = append(runningServices, svc)
			for k, v := range svc.Env {
				serviceEnv = append(serviceEnv, fmt.Sprintf("%s=%s", k, v))
			}
		}
	}

	// Defer cleanup of services and isolation resources
	defer func() {
		if e.services != nil && len(runningServices) > 0 {
			for _, svc := range runningServices {
				_ = e.services.Stop(context.Background(), runID, svc.Name)
			}
		}
		if e.isolation != nil {
			_ = e.isolation.Cleanup(context.Background(), runID)
		}
	}()

	redactor := redact.New(e.secrets...)

	// 2. Restore caches before setup and checks
	if e.cache != nil && len(cfg.Caches) > 0 {
		for _, c := range cfg.Caches {
			destPath := filepath.Join(workDir, c.Path)
			_, _ = e.cache.Restore(ctx, domain, c.Key, destPath)
		}
	}

	// 3. Run setup commands if present
	if len(cfg.Setup) > 0 {
		setupLogPath := logpipe.LogPath(e.stateDir, runID, "setup")
		setupPipe, err := logpipe.New(setupLogPath, redactor)
		if err != nil {
			return fmt.Errorf("create setup logpipe: %w", err)
		}
		defer setupPipe.Close()

		for _, cmdStr := range cfg.Setup {
			spec := isolation.Spec{
				RunID:          runID,
				JobName:        "setup",
				Command:        []string{"sh", "-c", cmdStr},
				Dir:            workDir,
				Env:            serviceEnv,
				Stdout:         setupPipe,
				Stderr:         setupPipe,
				ReadWritePaths: []string{workDir},
				Timeout:        e.defaultTimeout,
			}

			res, err := e.isolation.Run(ctx, spec)
			if err != nil {
				return fmt.Errorf("setup execution error: %w", err)
			}
			if res.ExitCode != 0 {
				return fmt.Errorf("setup command failed with exit code %d: %s", res.ExitCode, cmdStr)
			}
		}
	}

	// 4. Job runner implementation
	runner := scheduler.RunnerFunc(func(jobCtx context.Context, rID string, jobName string, job config.CheckJob) scheduler.JobResult {
		logPath := logpipe.LogPath(e.stateDir, rID, jobName)
		pipe, err := logpipe.New(logPath, redactor)
		if err != nil {
			return scheduler.JobResult{ExitCode: 1, Error: fmt.Errorf("create job logpipe: %w", err)}
		}
		defer pipe.Close()

		timeout := ParseTimeout(job.Timeout, e.defaultTimeout)
		execCtx, cancel := context.WithTimeout(jobCtx, timeout)
		defer cancel()

		// Prepare job environment
		var jobEnvs []string
		jobEnvs = append(jobEnvs, serviceEnv...)
		for k, v := range job.Env {
			jobEnvs = append(jobEnvs, fmt.Sprintf("%s=%s", k, v))
		}

		spec := isolation.Spec{
			RunID:          rID,
			JobName:        jobName,
			Command:        []string{"sh", "-c", job.Run},
			Dir:            workDir,
			Env:            jobEnvs,
			Stdout:         pipe,
			Stderr:         pipe,
			ReadWritePaths: []string{workDir},
			Timeout:        timeout,
		}

		res, err := e.isolation.Run(execCtx, spec)
		if err != nil {
			return scheduler.JobResult{ExitCode: 1, Error: err}
		}

		return scheduler.JobResult{ExitCode: res.ExitCode, Error: res.Error}
	})

	// 5. Run scheduler across checks DAG
	sched := scheduler.New(e.store, runner, scheduler.Options{Slots: e.slots})
	if err := sched.Run(ctx, runID, cfg.Checks); err != nil {
		return err
	}

	// 6. Save caches on success
	if e.cache != nil && len(cfg.Caches) > 0 {
		for _, c := range cfg.Caches {
			srcPath := filepath.Join(workDir, c.Path)
			_ = e.cache.Save(ctx, domain, isProtected, c.Key, srcPath)
		}
	}

	return nil
}
