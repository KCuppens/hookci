package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/cache"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/detect"
	"github.com/KCuppens/zerocideploy/agent/internal/executor"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/ids"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/recovery"
	"github.com/KCuppens/zerocideploy/agent/internal/scheduler"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
	"github.com/KCuppens/zerocideploy/agent/internal/sink"
	"github.com/KCuppens/zerocideploy/agent/internal/source"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func runRun(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)

	var (
		configFile string
		stateDir   string
		slots      int
		isoName    string
	)

	fs.StringVar(&configFile, "c", "", "path to .zeroci.yml config file")
	fs.StringVar(&configFile, "config", "", "path to .zeroci.yml config file")
	fs.StringVar(&stateDir, "s", defaultStateDir(), "path to state directory")
	fs.StringVar(&stateDir, "state-dir", defaultStateDir(), "path to state directory")
	fs.IntVar(&slots, "slots", scheduler.DefaultSlots(), "parallel job slots")
	fs.StringVar(&isoName, "isolation", "auto", "job isolation backend: auto, systemd or none")

	fs.Usage = func() {
		fmt.Fprintln(stdout, "Usage: zeroci run [flags] [dir]")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Execute check jobs for a repository locally.")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Flags:")
		fs.SetOutput(stdout)
		fs.PrintDefaults()
	}

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}

	workDir := "."
	if fs.NArg() > 0 {
		workDir = fs.Arg(0)
	}
	absWorkDir, err := filepath.Abs(workDir)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: resolve workdir: %v\n", err)
		return ExitUsage
	}

	// 1. Locate and load configuration
	var cfg *config.Config
	if configFile != "" {
		loaded, ok := loadRunConfig(configFile, stderr)
		if !ok {
			return ExitUsage
		}
		cfg = loaded
	} else {
		defaultPaths := []string{
			filepath.Join(absWorkDir, ".zeroci.yml"),
			filepath.Join(absWorkDir, ".zeroci.yaml"),
		}
		for _, p := range defaultPaths {
			if _, err := os.Stat(p); err == nil {
				loaded, ok := loadRunConfig(p, stderr)
				if !ok {
					return ExitUsage
				}
				cfg = loaded
				break
			}
		}

		// Fallback to auto-detect if no config file present
		if cfg == nil {
			det, err := detect.DetectDir(absWorkDir)
			if errors.Is(err, detect.ErrNothingDetected) {
				fmt.Fprintln(stderr, noChecksMessage)
				return ExitNoChecks
			}
			if err != nil {
				fmt.Fprintf(stderr, "zeroci: %v\n", err)
				return ExitUsage
			}
			cfg = det.Config
		}
	}

	if cfg.ZeroCIConfig.Checks == nil || len(cfg.ZeroCIConfig.Checks.Jobs) == 0 {
		fmt.Fprintln(stderr, "zeroci: no checks configured")
		return ExitNoChecks
	}

	// 2. Open store and initialize state directory
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		fmt.Fprintf(stderr, "zeroci: create state directory: %v\n", err)
		return ExitInternal
	}
	unlock, err := lockStateDir(stateDir)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %s: %v\n", stateDir, err)
		return ExitInternal
	}
	defer unlock()

	db, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: open database: %v\n", err)
		return ExitInternal
	}
	defer db.Close()

	// 3. Select isolation engine. Selection is explicit: auto never falls
	// back to none on Linux.
	selEnv := isolation.HostSelectEnv()
	selEnv.Warn = func(msg string) { fmt.Fprintf(stderr, "zeroci: warning: %s\n", msg) }
	iso, warnings, err := isolation.Select(isoName, selEnv)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitUsage
	}
	for _, w := range warnings {
		fmt.Fprintf(stderr, "zeroci: warning: %s\n", w)
	}

	docker := &services.Docker{}
	git := source.Git{Runner: execx.OS{}}
	mirrors := source.NewMirrors(filepath.Join(stateDir, "mirrors"), git)
	var hooks executor.Hooks
	if cacheStore, err := cache.New(cache.Options{Root: filepath.Join(stateDir, "cache")}); err != nil {
		fmt.Fprintf(stderr, "zeroci: warning: caches disabled: %v\n", err)
	} else {
		hooks.Cache = cacheStore
	}

	// 4. Perform crash recovery before starting new run
	rec := recovery.New(db, iso, docker, nil)
	if _, err := rec.Recover(ctx); err != nil {
		fmt.Fprintf(stderr, "zeroci: crash recovery warning: %v\n", err)
	}

	// 5. Create new Run record in store
	runID := ids.NewRunID()
	checks := cfg.Checks()
	jobs := make([]store.Job, 0, len(checks.Jobs))
	for _, job := range checks.Jobs {
		jobs = append(jobs, store.Job{Name: job.Name, Needs: job.Needs})
	}

	// Each local invocation is its own run, so the run ID stands in for the commit SHA
	// to keep the (repo, sha, event, env, attempt) key unique. The executor
	// checks out the working tree's committed HEAD.
	localRepo := source.LocalRepo(absWorkDir)
	runRec := store.Run{
		ID:          runID,
		Repo:        localRepo,
		SHA:         runID,
		Ref:         "HEAD",
		Event:       "local",
		Kind:        "check",
		TrustDomain: "trusted:" + localRepo,
	}
	if err := db.CreateRun(ctx, runRec, jobs); err != nil {
		fmt.Fprintf(stderr, "zeroci: create run in store: %v\n", err)
		return ExitInternal
	}

	ex, err := executor.New(executor.Options{
		StateDir:  stateDir,
		Store:     db,
		Isolation: iso,
		Source:    &source.Local{Git: git, Dir: absWorkDir, Mirrors: mirrors, Warn: stderr},
		Mirrors:   mirrors,
		Config: func(store.Run, string) (*config.ResolvedChecks, error) {
			return checks, nil
		},
		Hooks: hooks,
	})
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}

	// 6. Print run progress from the outbox while the run executes.
	pump := &sink.Pump{
		Store: db,
		Sink:  sink.NewStdout(sink.StdoutOptions{Out: stdout, Color: colorEnabled(stdout)}),
		Poll:  25 * time.Millisecond,
	}
	pumpCtx, stopPump := context.WithCancel(ctx)
	pumpErr := make(chan error, 1)
	go func() { pumpErr <- pump.Run(pumpCtx) }()

	// 7. Execute the run. Interrupting ctx cancels it through the scheduler,
	// which tears it down before Wait returns.
	if err := driveRun(ctx, scheduler.New(db, ex, scheduler.Options{Slots: slots}), runID); err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
	}

	// Stop the pump; Run drains once more before returning.
	stopPump()
	if err := <-pumpErr; err != nil {
		fmt.Fprintf(stderr, "zeroci: print run progress: %v\n", err)
	}

	// 8. Determine exit code from recorded run state
	finalRun, err := db.GetRun(context.Background(), runID)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: retrieve final run state: %v\n", err)
		return ExitInternal
	}

	if finalRun.State == store.RunSuccess {
		return ExitOK
	}
	if finalRun.Reason != "" {
		fmt.Fprintf(stderr, "zeroci: run %s: %s\n", finalRun.State, finalRun.Reason)
	}
	return ExitRunFailed
}

// driveRun submits runID to sched and waits for it to end. When ctx ends
// first the run is cancelled and waited for, so its teardown completes
// before sched closes.
func driveRun(ctx context.Context, sched *scheduler.Scheduler, runID string) error {
	defer sched.Close()
	if _, err := sched.Submit(ctx, runID); err != nil {
		return err
	}
	_, err := sched.Wait(ctx, runID)
	if err == nil || ctx.Err() == nil {
		return err
	}
	bg := context.WithoutCancel(ctx)
	if err := sched.Cancel(bg, runID, "cancelled"); err != nil {
		return err
	}
	_, err = sched.Wait(bg, runID)
	return err
}

// loadRunConfig loads the config at path and prints its diagnostics. It
// reports false when the file cannot be read or has errors; warnings alone
// let the run go ahead.
func loadRunConfig(path string, stderr io.Writer) (*config.Config, bool) {
	cfg, diags, err := config.Load(path, config.ParseOptions{})
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: load config %s: %v\n", path, err)
		return nil, false
	}
	if len(diags) > 0 {
		fmt.Fprint(stderr, diags.Format(path))
	}
	return cfg, !diags.HasErrors()
}

// colorEnabled reports whether run progress written to w may use colors.
func colorEnabled(w io.Writer) bool {
	f, ok := w.(*os.File)
	return ok && sink.ColorEnabled(f, os.Getenv)
}
