package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/cache"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/detect"
	"github.com/KCuppens/zerocideploy/agent/internal/egress"
	"github.com/KCuppens/zerocideploy/agent/internal/executor"
	"github.com/KCuppens/zerocideploy/agent/internal/ids"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/recovery"
	"github.com/KCuppens/zerocideploy/agent/internal/scheduler"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
	"github.com/KCuppens/zerocideploy/agent/internal/sink"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func runRun(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)

	var (
		configFile string
		stateDir   string
		slots      int
		unisolated bool
		timeoutStr string
	)

	fs.StringVar(&configFile, "c", "", "path to .zeroci.yml config file")
	fs.StringVar(&configFile, "config", "", "path to .zeroci.yml config file")
	fs.StringVar(&stateDir, "s", defaultStateDir(), "path to state directory")
	fs.StringVar(&stateDir, "state-dir", defaultStateDir(), "path to state directory")
	fs.IntVar(&slots, "slots", scheduler.DefaultSlots(), "parallel job slots")
	fs.BoolVar(&unisolated, "unisolated", false, "run jobs directly on host without systemd isolation")
	fs.StringVar(&timeoutStr, "timeout", "10m", "default timeout for check jobs")

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
			det, err := detect.Detect(absWorkDir)
			if err != nil || det == nil || det.Config == nil || det.Config.ZeroCIConfig.Checks == nil || len(det.Config.ZeroCIConfig.Checks.Jobs) == 0 {
				fmt.Fprintln(stderr, "zeroci: no checks detected")
				return ExitNoChecks
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

	dbPath := filepath.Join(stateDir, "zeroci.db")
	db, err := store.Open(ctx, dbPath)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: open database: %v\n", err)
		return ExitInternal
	}
	defer db.Close()

	// 3. Select isolation engine
	var iso isolation.Isolation
	if unisolated || !hasSystemd() {
		iso = isolation.NewNone(nil)
	} else {
		iso = isolation.NewSystemd(nil)
	}

	servicesMgr := services.NewManager(nil)
	cacheMgr := cache.NewManager(filepath.Join(stateDir, "caches"), nil)

	// 4. Perform crash recovery before starting new run
	rec := recovery.New(db, iso, servicesMgr, nil)
	if _, err := rec.Recover(ctx); err != nil {
		fmt.Fprintf(stderr, "zeroci: crash recovery warning: %v\n", err)
	}

	// 5. Create new Run record in store
	runID := ids.NewRunID()
	var jobNames []string
	for name := range cfg.ZeroCIConfig.Checks.Jobs {
		jobNames = append(jobNames, name)
	}
	sort.Strings(jobNames)

	runRec := &store.Run{
		ID:          runID,
		Repo:        "local",
		Ref:         "HEAD",
		TrustDomain: store.TrustDomainLocal,
	}
	if err := db.CreateRun(ctx, runRec, jobNames); err != nil {
		fmt.Fprintf(stderr, "zeroci: create run in store: %v\n", err)
		return ExitInternal
	}

	// 6. Start real-time stdout drain
	s := sink.NewStdout(stdout)
	drainCtx, cancelDrain := context.WithCancel(ctx)
	drainDone := make(chan struct{})
	go func() {
		_ = s.DrainLoop(drainCtx, db, 25*time.Millisecond)
		close(drainDone)
	}()

	// 7. Execute the run
	exec := executor.New(executor.Options{
		StateDir:       stateDir,
		Store:          db,
		Isolation:      iso,
		Services:       servicesMgr,
		Cache:          cacheMgr,
		Slots:          slots,
		DefaultTimeout: executor.ParseTimeout(&timeoutStr, 10*time.Minute),
	})

	_ = exec.ExecuteRun(ctx, runID, cfg, absWorkDir, egress.TrustDomainLocal, true)

	// Stop drain loop and do a final drain
	cancelDrain()
	<-drainDone
	_ = s.Drain(context.Background(), db)

	// 8. Determine exit code from recorded run state
	finalRun, err := db.GetRun(context.Background(), runID)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: retrieve final run state: %v\n", err)
		return ExitInternal
	}

	if finalRun.State == store.RunStateSuccess {
		return ExitOK
	}
	return ExitRunFailed
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

func hasSystemd() bool {
	if os.Geteuid() != 0 {
		return false
	}
	_, err := os.Stat("/run/systemd/system")
	return err == nil
}
