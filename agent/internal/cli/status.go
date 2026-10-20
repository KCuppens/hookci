package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"text/tabwriter"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// statusRuns is how many recent runs status lists.
const statusRuns = 20

// cmdStatus lists the recent runs, or the jobs of one run.
func cmdStatus(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "print a JSON array")
	dirFlags := addStateDirFlags(fs, d)
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: zeroci [global flags] status [run] [--json] [--state-dir DIR | --installation ID]")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "List the last 20 runs, or the jobs of one run.")
		fs.PrintDefaults()
	}
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if len(pos) > 1 {
		fs.Usage()
		return ExitUsage
	}
	stateDir, ok := dirFlags.resolve(stderr)
	if !ok {
		return ExitUsage
	}
	d.Globals.StateDir = stateDir

	db, err := openStateStore(d)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: open store: %v\n", err)
		return ExitInternal
	}
	if db != nil {
		defer db.Close()
	}
	now := d.Clock()

	if len(pos) == 0 {
		runs := []store.Run{}
		if db != nil {
			if runs, err = db.ListRuns(ctx, store.RunFilter{Limit: statusRuns}); err != nil {
				fmt.Fprintf(stderr, "zeroci: list runs: %v\n", err)
				return ExitInternal
			}
		}
		if *asJSON {
			return writeJSON(stdout, stderr, runs)
		}
		tw := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tREPO\tREF\tSHA\tSTATE\tAGE\tDURATION")
		for _, r := range runs {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", r.ID, r.Repo, r.Ref, short(r.SHA), r.State,
				fmtDuration(now.Sub(r.CreatedAt)), spanDuration(r.StartedAt, r.FinishedAt, now))
		}
		return flushTable(tw, stderr)
	}

	runID := pos[0]
	if code := requireRun(ctx, db, runID, stderr); code != ExitOK {
		return code
	}
	jobs, err := db.Jobs(ctx, runID)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: list jobs: %v\n", err)
		return ExitInternal
	}
	if *asJSON {
		if jobs == nil {
			jobs = []store.Job{}
		}
		return writeJSON(stdout, stderr, jobs)
	}
	tw := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tSTATE\tEXIT\tDURATION\tREASON")
	for _, j := range jobs {
		exit, dur := "-", "-"
		if j.ExitCode != nil {
			exit = strconv.Itoa(*j.ExitCode)
		}
		if j.DurationMS != nil {
			dur = fmtDuration(time.Duration(*j.DurationMS) * time.Millisecond)
		} else if j.StartedAt != nil {
			dur = spanDuration(j.StartedAt, j.FinishedAt, now)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", j.Name, j.State, exit, dur, j.Reason)
	}
	return flushTable(tw, stderr)
}

// openStateStore opens <state>/agent.db for status and logs. It returns a
// nil store when the state dir has none yet, which means no runs.
func openStateStore(d Deps) (*store.Store, error) {
	path := filepath.Join(d.Globals.StateDir, "agent.db")
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	return store.Open(path, store.WithClock(d.Clock))
}

// requireRun prints the not-found error and returns ExitUsage when db has
// no run runID.
func requireRun(ctx context.Context, db *store.Store, runID string, stderr io.Writer) int {
	if db == nil {
		fmt.Fprintf(stderr, "zeroci: run %s not found\n", runID)
		return ExitUsage
	}
	_, err := db.GetRun(ctx, runID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		fmt.Fprintf(stderr, "zeroci: run %s not found\n", runID)
		return ExitUsage
	case err != nil:
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	return ExitOK
}

func writeJSON(stdout, stderr io.Writer, v any) int {
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	return ExitOK
}

func flushTable(tw *tabwriter.Writer, stderr io.Writer) int {
	if err := tw.Flush(); err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	return ExitOK
}

func short(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// spanDuration is finished-started, or now-started while still going; "-"
// before the start.
func spanDuration(started, finished *time.Time, now time.Time) string {
	switch {
	case started == nil:
		return "-"
	case finished == nil:
		return fmtDuration(now.Sub(*started))
	default:
		return fmtDuration(finished.Sub(*started))
	}
}

// fmtDuration rounds d to tenths of a second under a minute and to seconds
// above.
func fmtDuration(d time.Duration) string {
	if d < time.Minute {
		return d.Round(100 * time.Millisecond).String()
	}
	return d.Round(time.Second).String()
}
