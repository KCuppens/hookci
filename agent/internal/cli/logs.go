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

	"github.com/KCuppens/zerocideploy/agent/internal/logpipe"
)

func runLogs(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("logs", flag.ContinueOnError)
	fs.SetOutput(stderr)

	var (
		stateDir string
		follow   bool
	)
	fs.StringVar(&stateDir, "s", defaultStateDir(), "path to state directory")
	fs.StringVar(&stateDir, "state-dir", defaultStateDir(), "path to state directory")
	fs.BoolVar(&follow, "f", false, "follow log stream in real time")
	fs.BoolVar(&follow, "follow", false, "follow log stream in real time")

	fs.Usage = func() {
		fmt.Fprintln(stdout, "Usage: zeroci logs [flags] <run-id> [job-name]")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "View or tail output logs for a run or an individual job.")
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

	if fs.NArg() == 0 {
		fmt.Fprintln(stderr, "zeroci: run ID required")
		fs.Usage()
		return ExitUsage
	}

	runID := fs.Arg(0)
	logsDir := filepath.Join(stateDir, "runs", runID, "logs")

	// Specific job log requested
	if fs.NArg() > 1 {
		jobName := fs.Arg(1)
		logFile := logpipe.LogPath(stateDir, runID, jobName)

		if follow {
			ch, err := logpipe.TailFile(ctx, logFile)
			if err != nil {
				fmt.Fprintf(stderr, "zeroci: log not found for job %q: %v\n", jobName, err)
				return ExitUsage
			}
			for line := range ch {
				fmt.Fprintln(stdout, line)
			}
			return ExitOK
		}

		f, err := os.Open(logFile)
		if err != nil {
			fmt.Fprintf(stderr, "zeroci: log not found for job %q: %v\n", jobName, err)
			return ExitUsage
		}
		defer f.Close()
		if _, err := io.Copy(stdout, f); err != nil {
			fmt.Fprintf(stderr, "zeroci: read log: %v\n", err)
			return ExitInternal
		}
		return ExitOK
	}

	// All logs for run
	entries, err := os.ReadDir(logsDir)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: no logs found for run %q: %v\n", runID, err)
		return ExitUsage
	}

	var files []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".log" {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	if len(files) == 0 {
		fmt.Fprintf(stderr, "zeroci: no log files in run %q\n", runID)
		return ExitUsage
	}

	for _, fileName := range files {
		jobName := fileName[:len(fileName)-len(filepath.Ext(fileName))]
		if len(files) > 1 {
			fmt.Fprintf(stdout, "=== %s ===\n", jobName)
		}

		fullPath := filepath.Join(logsDir, fileName)
		f, err := os.Open(fullPath)
		if err != nil {
			continue
		}
		_, _ = io.Copy(stdout, f)
		_ = f.Close()
		if len(files) > 1 {
			fmt.Fprintln(stdout)
		}
	}

	return ExitOK
}
