// Package cli implements the zeroci command-line interface: argument
// parsing, subcommand dispatch, and help/version output.
//
// Subcommands live in the commands map below, one entry per command. Later
// tickets add commands (build, deploy, status, ...) by adding one map entry
// each; dispatch and help generation here do not change.
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
	run     func(ctx context.Context, args []string, stdout, stderr io.Writer) int
}

func commandTable() map[string]command {
	return map[string]command{
		"detect": {
			summary: "auto-detect project ecosystem and print inferred config",
			run:     runDetect,
		},
		"help": {
			summary: "show help for zeroci",
			run: func(_ context.Context, _ []string, stdout, _ io.Writer) int {
				printUsage(stdout)
				return ExitOK
			},
		},
		"init": {
			summary: "scaffold a .zeroci.yml config file for the project",
			run:     runInit,
		},
		"logs": {
			summary: "view or tail check job logs",
			run:     runLogs,
		},
		"run": {
			summary: "execute check jobs locally",
			run:     runRun,
		},
		"status": {
			summary: "show run and job status",
			run:     runStatus,
		},
		"validate": {
			summary: "validate a zeroci configuration file",
			run:     runValidate,
		},
		"version": {
			summary: "print the zeroci version",
			run: func(_ context.Context, _ []string, stdout, _ io.Writer) int {
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return dispatch(ctx, args, stdout, stderr)
}

// dispatch parses global flags and runs the named subcommand with ctx.
func dispatch(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("zeroci", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.Usage = func() { printUsage(stdout) }

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		fmt.Fprintln(stderr, err)
		printUsage(stderr)
		return ExitUsage
	}

	rest := fs.Args()
	if len(rest) == 0 {
		printUsage(stdout)
		return ExitOK
	}

	name := rest[0]
	cmds := commandTable()
	cmd, ok := cmds[name]
	if !ok {
		fmt.Fprintf(stderr, "zeroci: unknown command %q\n", name)
		printUsage(stderr)
		return ExitUsage
	}
	return cmd.run(ctx, rest[1:], stdout, stderr)
}

func printUsage(w io.Writer) {
	fmt.Fprintln(w, "usage: zeroci <command> [arguments]")
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
