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
		"detect": {
			summary: "auto-detect project ecosystem and print inferred config",
			run:     noDeps(runDetect),
		},
		"help": {
			summary: "show help for zeroci",
			run: func(_ context.Context, _ Deps, _ []string, stdout, _ io.Writer) int {
				printUsage(stdout)
				return ExitOK
			},
		},
		"init": {
			summary: "scaffold a .zeroci.yml config file for the project",
			run:     noDeps(runInit),
		},
		"logs": {
			summary: "print or follow job logs: logs <run> [job] [-f]",
			run:     cmdLogs,
		},
		"run": {
			summary: "run the checks of the current repo's HEAD: run [job]",
			run:     cmdRun,
		},
		"status": {
			summary: "list recent runs, or one run's jobs: status [run] [--json]",
			run:     cmdStatus,
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return dispatch(ctx, args, stdout, stderr, newDeps)
}

// dispatch parses the global flags and runs the named command with ctx and
// the host deps from newDeps.
func dispatch(ctx context.Context, args []string, stdout, stderr io.Writer, newDeps func(Globals, io.Writer) Deps) int {
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
