package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strconv"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/agentconf"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/daemon"
	"github.com/KCuppens/zerocideploy/agent/internal/executor"
	"github.com/KCuppens/zerocideploy/agent/internal/hubclient"
	"github.com/KCuppens/zerocideploy/agent/internal/redact"
	"github.com/KCuppens/zerocideploy/agent/internal/scheduler"
	"github.com/KCuppens/zerocideploy/agent/internal/source"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
	"github.com/KCuppens/zerocideploy/agent/internal/version"
)

// unsupportedRetry is how long agent waits before reconnecting to a hub that
// refused its protocol version.
const unsupportedRetry = time.Hour

// agentRevokedMessage is printed when the hub has revoked the agent.
const agentRevokedMessage = "agent revoked: run zeroci connect with a new pair token"

// cmdAgent runs the agent daemon of the state directory zeroci connect
// paired until a signal stops it or the hub revokes the agent.
func cmdAgent(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("agent", flag.ContinueOnError)
	fs.SetOutput(stderr)
	stateDir := fs.String("state-dir", d.Globals.StateDir, "agent state directory, as given to zeroci connect")
	installation := fs.Int64("installation", 0, "run the agent of this installation from "+defaultStateRoot+"/<ID>, as the zeroci-agent@ unit does")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: zeroci [global flags] agent [--state-dir DIR | --installation ID]")
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
	if *installation < 0 {
		fmt.Fprintln(stderr, "zeroci: --installation must be a positive installation id")
		return ExitUsage
	}
	if *installation > 0 {
		*stateDir = filepath.Join(defaultStateRoot, strconv.FormatInt(*installation, 10))
	}

	conf, err := agentconf.Load(*stateDir)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitUsage
	}
	red, _ := redact.New([]string{conf.Credential}, nil)
	errw := red.Writer(stderr)
	defer errw.Close()
	level := slog.LevelInfo
	if d.Globals.Verbose {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(errw, &slog.HandlerOptions{Level: level}))

	h, code := openHost(ctx, d, *stateDir, errw)
	if code != ExitOK {
		return code
	}
	defer h.close()
	hooks := executorHooks(d, *stateDir, errw)
	exec := func(co source.Checkout, checks *config.ResolvedChecks, policy executor.RunPolicy) (scheduler.JobRunner, error) {
		return executor.New(executor.Options{
			StateDir:  *stateDir,
			Store:     h.db,
			Isolation: h.iso,
			JobUser:   h.jobUser,
			Source:    checkedOut(co),
			Config: func(store.Run, string) (*config.ResolvedChecks, error) {
				return checks, nil
			},
			Policy: policy,
			Hooks:  hooks,
			Clock:  d.Clock,
		})
	}

	for {
		// A fresh daemon each time: the next one settles the triggers the
		// last one accepted but did not start.
		dm := daemon.New(conf, h.db, exec, daemon.Options{
			StateDir: *stateDir,
			Version:  version.Version,
			Logger:   log,
			JobUser:  h.jobUser,
			Slots:    d.Globals.Slots,
		})
		err := dm.Run(ctx)
		switch {
		case ctx.Err() != nil:
			return ExitOK
		case errors.Is(err, hubclient.ErrRevoked):
			fmt.Fprintln(errw, agentRevokedMessage)
			return ExitRevoked
		case errors.Is(err, hubclient.ErrAgentTooOld):
			fmt.Fprintf(errw, "zeroci: agent_too_old: %v\n", err)
			return ExitInternal
		case errors.Is(err, hubclient.ErrUnsupported):
			log.Error("hub refused this agent version; retrying in an hour", "err", err)
			select {
			case <-ctx.Done():
				return ExitOK
			case <-d.After(unsupportedRetry):
			}
		default:
			fmt.Fprintf(errw, "zeroci: %v\n", err)
			return ExitInternal
		}
	}
}
