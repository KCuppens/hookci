package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/KCuppens/hookci/agent/internal/agentconf"
	"github.com/KCuppens/hookci/agent/internal/cache"
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
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: hookci [global flags] agent [--state-dir DIR | --installation ID]")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "Connect to the hub and run the checks it sends until stopped.")
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
	exec := func(co source.Checkout, checks *config.ResolvedChecks, policy executor.RunPolicy, protected bool) (scheduler.JobRunner, error) {
		return executor.New(executor.Options{
			StateDir:  stateDir,
			Store:     h.db,
			Isolation: h.iso,
			JobUser:   h.jobUser,
			Source:    checkedOut(co),
			Config: func(store.Run, string) (*config.ResolvedChecks, error) {
				return checks, nil
			},
			Protected: func(store.Run) bool { return protected },
			Policy:    policy,
			Hooks:     hooks,
			Clock:     d.Clock,
		})
	}

	for {
		// A fresh daemon each time: the next one settles the triggers the
		// last one accepted but did not start.
		dm := daemon.New(conf, h.db, exec, daemon.Options{
			StateDir: stateDir,
			Version:  version.Version,
			Logger:   log,
			JobUser:  h.jobUser,
			Slots:    d.Globals.Slots,
			Cache:    jobCache,
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
