// Package cli implements the zeroci command-line interface: argument
// parsing, subcommand dispatch, and help/version output.
//
// Subcommands live in the commands map below, one entry per command. Global
// flags (--state-dir, --slots, --isolation, -v) come before the command.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"syscall"

	"github.com/KCuppens/zerocideploy/agent/internal/version"
)

type command struct {
	summary string
	run     func(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int
}

// noDeps adapts a command that needs no host deps.
func noDeps(run func(ctx context.Context, args []string, stdout, stderr io.Writer) int) func(context.Context, Deps, []string, io.Writer, io.Writer) int {
	return func(ctx context.Context, _ Deps, args []string, stdout, stderr io.Writer) int {
		return run(ctx, args, stdout, stderr)
	}
}

func commandTable() map[string]command {
	return map[string]command{
		"agent": {
			summary: "connect to the hub and run the checks it sends: agent [--state-dir DIR | --installation ID]",
			run:     cmdAgent,
		},
		"connect": {
			summary: "pair this machine with a hub: connect [pair-token] [--hub URL] [--name NAME] [--state-dir DIR] [--force] [--no-service]",
			run:     cmdConnect,
		},
		"deploy": {
			summary: "preview a deployment without running it: deploy <env> --dry-run [--repo owner/name] [--sha SHA] [--state-dir DIR | --installation ID]",
			run:     cmdDeploy,
		},
		"detect": {
			summary: "auto-detect project ecosystem and print inferred config",
			run:     noDeps(runDetect),
		},
		"doctor": {
			summary: "diagnose this host and its path to the hub: doctor [--hub URL] [--state-root DIR] [--json]",
			run:     cmdDoctor,
		},
		"gc": {
			summary: "remove old deploy images, cap the build cache and delete finished run dirs: gc [--dry-run] [--state-dir DIR | --installation ID]",
			run:     cmdGC,
		},
		"help": {
			summary: "show help for zeroci",
			run: func(_ context.Context, _ Deps, _ []string, stdout, _ io.Writer) int {
				printUsage(stdout)
				return ExitOK
			},
		},
		"hub": {
			summary: "set up or upgrade a self-hosted hub on Cloudflare through npx zeroci-hub: hub setup|upgrade [zeroci-hub options]",
			run:     cmdHub,
		},
		"init": {
			summary: "scaffold a .zeroci.yml config file for the project (--deploy adds a deployment)",
			run:     noDeps(runInit),
		},
		"logs": {
			summary: "print or follow job logs: logs <run> [job] [-f] [--state-dir DIR | --installation ID]",
			run:     cmdLogs,
		},
		"run": {
			summary: "run the checks of the current repo's HEAD: run [job]",
			run:     cmdRun,
		},
		"runs": {
			summary: "export finished runs or report their medians and savings vs a hosted CI baseline: runs export|stats",
			run:     cmdRuns,
		},
		"retry": {
			summary: "retry a Failed or Interrupted deploy run: retry <run_id> [--state-dir DIR | --installation ID]",
			run:     cmdRetry,
		},
		"sink": {
			summary: "manage the repo's Telegram and webhook sinks on the hub: sink add telegram|webhook, sink ls, sink rm <id>, sink test <id>",
			run:     cmdSink,
		},
		"status": {
			summary: "list recent runs, or one run's jobs: status [run] [--json] [--state-dir DIR | --installation ID]",
			run:     cmdStatus,
		},
		"upgrade": {
			summary: "install a signed release and restart the agents: upgrade [--version vX.Y.Z] [--check] [--allow-downgrade] [--refresh-trust-root]",
			run:     cmdUpgrade,
		},
		"validate": {
			summary: "validate a zeroci configuration file",
			run:     noDeps(runValidate),
		},
		"version": {
			summary: "print the zeroci version",
			run: func(_ context.Context, _ Deps, _ []string, stdout, _ io.Writer) int {
				fmt.Fprintln(stdout, version.String())
				return ExitOK
			},
		},
	}
}

// Main runs the zeroci CLI with args (excluding the program name) and
// returns the process exit code. stdout and stderr receive command output;
// callers typically pass os.Stdout and os.Stderr. SIGINT and SIGTERM cancel
// the context passed to the running command.
func Main(args []string, stdout, stderr io.Writer) int {
	return MainWithDeps(args, stdout, stderr, DefaultDeps)
}

// MainWithDeps is Main with the host deps built by newDeps from the parsed
// globals. End-to-end tests use it to swap the host commands of recovery and
// the network setup for fakes.
func MainWithDeps(args []string, stdout, stderr io.Writer, newDeps func(Globals, io.Writer) Deps) int {
	ctx, stop := signalContext()
	defer stop()
	return dispatch(ctx, args, stdout, stderr, newDeps)
}

// signalContext is cancelled by the first SIGINT or SIGTERM, which then gets
// its default handling back: a second one kills a run stuck in teardown.
func signalContext() (context.Context, context.CancelFunc) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	context.AfterFunc(ctx, stop)
	return ctx, stop
}

// dispatch parses the global flags and runs the named command with ctx and
// the host deps from newDeps.
func dispatch(ctx context.Context, args []string, stdout, stderr io.Writer, newDeps func(Globals, io.Writer) Deps) int {
	if len(args) == 1 && args[0] == "--version" {
		fmt.Fprintln(stdout, version.String())
		return ExitOK
	}
	fs := flag.NewFlagSet("zeroci", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.Usage = func() { printUsage(stdout) }

	g, rest, err := parseGlobals(fs, args, os.Getenv)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		printUsage(stderr)
		return ExitUsage
	}
	if len(rest) == 0 {
		printUsage(stdout)
		return ExitOK
	}

	name := rest[0]
	cmd, ok := commandTable()[name]
	if !ok {
		fmt.Fprintf(stderr, "zeroci: unknown command %q\n", name)
		printUsage(stderr)
		return ExitUsage
	}
	return cmd.run(ctx, newDeps(g, stderr), rest[1:], stdout, stderr)
}

func printUsage(w io.Writer) {
	fmt.Fprintln(w, "usage: zeroci [global flags] <command> [arguments]")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "global flags:")
	fmt.Fprintln(w, "  --state-dir DIR   state directory (default $ZEROCI_STATE_DIR, $XDG_STATE_HOME/zeroci or ~/.local/state/zeroci)")
	fmt.Fprintln(w, "  --slots N         parallel job slots (default half the CPUs, at least 1)")
	fmt.Fprintln(w, "  --isolation MODE  job isolation: auto, systemd or none (default auto)")
	fmt.Fprintln(w, "  -v                print step events and mirror job output")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "commands:")

	cmds := commandTable()
	names := make([]string, 0, len(cmds))
	for n := range cmds {
		names = append(names, n)
	}
	sort.Strings(names)

	for _, n := range names {
		fmt.Fprintf(w, "  %-10s %s\n", n, cmds[n].summary)
	}
}
