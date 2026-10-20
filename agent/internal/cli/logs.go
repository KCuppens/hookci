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

	"github.com/KCuppens/zerocideploy/agent/internal/logpipe"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// logsPoll is how often logs -f reads the logs again.
const logsPoll = 500 * time.Millisecond

// setupLog is the log name of the setup phase and teardown: logs/setup.log.
const setupLog = "setup"

// cmdLogs prints the setup log and then the job logs of a run, each under a
// "==> <name> <==" header, or one log. With -f it keeps printing until the
// run ends or its agent is gone.
func cmdLogs(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("logs", flag.ContinueOnError)
	fs.SetOutput(stderr)
	follow := fs.Bool("f", false, "follow the logs until the run ends")
	dirFlags := addStateDirFlags(fs, d)
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: zeroci [global flags] logs <run> [job|setup] [-f] [--state-dir DIR | --installation ID]")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "Print the setup log and the job logs of a run in plan order, or one log.")
		fs.PrintDefaults()
	}
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if len(pos) == 0 || len(pos) > 2 {
		fs.Usage()
		return ExitUsage
	}
	stateDir, ok := dirFlags.resolve(stderr)
	if !ok {
		return ExitUsage
	}
	d.Globals.StateDir = stateDir
	runID := pos[0]

	db, err := openStateStore(d)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: open store: %v\n", err)
		return ExitInternal
	}
	if db != nil {
		defer db.Close()
	}
	if code := requireRun(ctx, db, runID, stderr); code != ExitOK {
		return code
	}
	jobs, err := db.Jobs(ctx, runID)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: list jobs: %v\n", err)
		return ExitInternal
	}
	names := make([]string, 0, len(jobs)+1)
	if len(pos) == 1 || pos[1] == setupLog {
		names = append(names, setupLog)
	}
	for _, j := range jobs {
		if (len(pos) == 1 || j.Name == pos[1]) && j.Name != setupLog {
			names = append(names, j.Name)
		}
	}
	if len(names) == 0 {
		fmt.Fprintf(stderr, "zeroci: run %s has no job %q\n", runID, pos[1])
		return ExitUsage
	}

	l := &logPrinter{
		out:     stdout,
		runDir:  filepath.Join(d.Globals.StateDir, "runs", runID),
		headers: len(pos) == 1,
		offsets: make(map[string]int64, len(names)),
	}
	if !*follow {
		for _, name := range names {
			// A run that never reached setup has no setup log to show.
			if err := l.print(name, name != setupLog); err != nil {
				fmt.Fprintf(stderr, "zeroci: %v\n", err)
				return ExitInternal
			}
		}
		return ExitOK
	}

	for {
		// The agent is probed before the reads: once it is gone it has
		// written all it ever will, so this pass drains every log. Likewise
		// a log seen finished before it is read has nothing left to write.
		alive, err := stateDirLocked(d.Globals.StateDir)
		if err != nil {
			fmt.Fprintf(stderr, "zeroci: %v\n", err)
			return ExitInternal
		}
		run, err := db.GetRun(ctx, runID)
		if err == nil {
			jobs, err = db.Jobs(ctx, runID)
		}
		if err != nil {
			if ctx.Err() != nil {
				return ExitOK
			}
			fmt.Fprintf(stderr, "zeroci: read run: %v\n", err)
			return ExitInternal
		}
		state := make(map[string]store.JobState, len(jobs))
		for _, j := range jobs {
			state[j.Name] = j.State
		}
		pending := names[:0]
		for _, name := range names {
			if err := l.print(name, false); err != nil {
				fmt.Fprintf(stderr, "zeroci: %v\n", err)
				return ExitInternal
			}
			// The setup log ends with teardown, which precedes the run's
			// terminal state.
			done := run.State.Terminal()
			if name != setupLog {
				done = state[name].Terminal()
			}
			if !done {
				pending = append(pending, name)
			}
		}
		names = pending
		if len(names) == 0 {
			return ExitOK
		}
		if !alive {
			fmt.Fprintf(stderr, "zeroci: no zeroci process is running run %s; stopped following\n", runID)
			return ExitOK
		}
		select {
		case <-ctx.Done():
			return ExitOK
		case <-d.After(logsPoll):
		}
	}
}

// logPrinter prints new log bytes of a run's jobs, with a header whenever
// the job changes.
type logPrinter struct {
	out     io.Writer
	runDir  string
	headers bool
	offsets map[string]int64
	last    string // job of the last printed bytes
}

// print writes the bytes of name's log after the last read. With always
// set, the header is printed even when there are none.
func (l *logPrinter) print(name string, always bool) error {
	data, next, err := logpipe.ReadLog(logpipe.LogPath(l.runDir, name), l.offsets[name])
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if len(data) == 0 && !always {
		return nil
	}
	if l.headers && l.last != name {
		if l.last != "" {
			fmt.Fprintln(l.out)
		}
		fmt.Fprintf(l.out, "==> %s <==\n", name)
	}
	l.last = name
	l.offsets[name] = next
	_, err = l.out.Write(data)
	return err
}
