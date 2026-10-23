package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/KCuppens/hookci/agent/internal/agentconf"
	"github.com/KCuppens/hookci/agent/internal/cache"
	"github.com/KCuppens/hookci/agent/internal/capacity"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/daemon"
	"github.com/KCuppens/hookci/agent/internal/executor"
	"github.com/KCuppens/hookci/agent/internal/hubclient"
	"github.com/KCuppens/hookci/agent/internal/redact"
	"github.com/KCuppens/hookci/agent/internal/scheduler"
	"github.com/KCuppens/hookci/agent/internal/source"
	"github.com/KCuppens/hookci/agent/internal/store"
	"github.com/KCuppens/hookci/agent/internal/version"
)

// unsupportedRetry is how long agent waits before reconnecting to a hub that
// refused its protocol version.
const unsupportedRetry = time.Hour

// agentRevokedMessage is printed when the hub has revoked the agent.
const agentRevokedMessage = "agent revoked: run hookci connect with a new pair token"

// cmdAgent runs the agent daemon of the state directory hookci connect
// paired until a signal stops it or the hub revokes the agent.
func cmdAgent(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("agent", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dirFlags := addStateDirFlags(fs, d)
	cpuBudget := fs.String("cpu-budget", os.Getenv(envCPUBudget), "")
	memBudget := fs.String("mem-budget", os.Getenv(envMemBudget), "")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: hookci [global flags] agent [--state-dir DIR | --installation ID] [--cpu-budget CORES] [--mem-budget SIZE]")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "Connect to the hub and run the checks it sends until stopped. Triggers run")
		fmt.Fprintln(stderr, "one at a time per branch or pull request, side by side across them.")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "  --cpu-budget CORES  sum of job CPU limits running at once (default $HOOKCI_CPU_BUDGET, else all CPUs)")
		fmt.Fprintln(stderr, "  --mem-budget SIZE   sum of job memory limits running at once, e.g. 32G (default $HOOKCI_MEM_BUDGET, else none)")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "A job's cpus is its guaranteed share; while the budget has idle CPU, running")
		fmt.Fprintln(stderr, "jobs are lent it up to their max_cpus. The hub can override the budget.")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "Under pressure (CPU or memory stalls, little free memory) no new setup or job")
		fmt.Fprintln(stderr, "starts and lent CPU is taken back; nothing is killed. One setup or job always")
		fmt.Fprintln(stderr, "runs when nothing else does.")
	}
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if len(pos) != 0 {
		fs.Usage()
		return ExitUsage
	}
	budget, err := parseBudget(*cpuBudget, *memBudget)
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitUsage
	}
	stateDir, ok := dirFlags.resolve(stderr)
	if !ok {
		return ExitUsage
	}

	conf, err := agentconf.Load(stateDir)
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitNotConfigured
	}
	red, _ := redact.New([]string{conf.Credential}, nil)
	errw := red.Writer(stderr)
	defer errw.Close()
	level := slog.LevelInfo
	if d.Globals.Verbose {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(errw, &slog.HandlerOptions{Level: level}))

	h, code := openHost(ctx, d, stateDir, errw)
	if code != ExitOK {
		return code
	}
	defer h.close()
	hooks := executorHooks(d, stateDir, errw)
	jobCache, _ := hooks.Cache.(*cache.Cache) // for GC eviction; nil when d.Hooks brings another Cache
	exec := func(co source.Checkout, checks *config.ResolvedChecks, policy executor.RunPolicy, cacheFallback []string) (scheduler.JobRunner, error) {
		return executor.New(executor.Options{
			StateDir:  stateDir,
			Store:     h.db,
			Isolation: h.iso,
			JobUser:   h.jobUser,
			Source:    checkedOut(co),
			Config: func(store.Run, string) (*config.ResolvedChecks, error) {
				return checks, nil
			},
			CacheFallback: cacheFallback,
			Policy:        policy,
			Hooks:         hooks,
			Clock:         d.Clock,
		})
	}
	osRelease := d.osRelease()
	// One pool across daemon restarts: work of the last daemon has
	// returned its share before the next one starts.
	pool := capacity.New(capacity.Options{
		CPUs:        budget.CPUs,
		MemoryBytes: budget.MemoryBytes,
		Host:        capacity.ProcHost{},
		Logger:      log,
	})

	for {
		// A fresh daemon each time: the next one settles the triggers the
		// last one accepted but did not start.
		dm := daemon.New(conf, h.db, exec, daemon.Options{
			StateDir:      stateDir,
			Version:       version.Version,
			OSRelease:     osRelease,
			Logger:        log,
			JobUser:       h.jobUser,
			Slots:         d.Globals.Slots,
			Pool:          pool,
			BudgetDefault: budget,
			Cache:         jobCache,
		})
		err := dm.Run(ctx)
		switch {
		case ctx.Err() != nil:
			return ExitOK
		case errors.Is(err, hubclient.ErrRevoked):
			fmt.Fprintln(errw, agentRevokedMessage)
			return ExitRevoked
		case errors.Is(err, hubclient.ErrAgentTooOld):
			fmt.Fprintf(errw, "hookci: agent_too_old: %v\n", err)
			return ExitAgentTooOld
		case errors.Is(err, hubclient.ErrUnsupported):
			log.Error("hub refused this agent version; retrying in an hour", "err", err)
			select {
			case <-ctx.Done():
				return ExitOK
			case <-d.After(unsupportedRetry):
			}
		default:
			fmt.Fprintf(errw, "hookci: %v\n", err)
			return ExitInternal
		}
	}
}
