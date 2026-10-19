package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"text/tabwriter"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func runStatus(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(stderr)

	var (
		stateDir string
		limit    int
	)
	fs.StringVar(&stateDir, "s", defaultStateDir(), "path to state directory")
	fs.StringVar(&stateDir, "state-dir", defaultStateDir(), "path to state directory")
	fs.IntVar(&limit, "n", 20, "max runs to list")
	fs.IntVar(&limit, "limit", 20, "max runs to list")

	fs.Usage = func() {
		fmt.Fprintln(stdout, "Usage: zeroci status [flags] [run-id]")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Show status of runs or inspect a specific run and its jobs.")
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

	db, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: open store: %v\n", err)
		return ExitInternal
	}
	defer db.Close()

	if fs.NArg() > 0 {
		runID := fs.Arg(0)
		run, err := db.GetRun(ctx, runID)
		if err != nil {
			fmt.Fprintf(stderr, "zeroci: run %q not found: %v\n", runID, err)
			return ExitUsage
		}

		fmt.Fprintf(stdout, "Run ID:      %s\n", run.ID)
		fmt.Fprintf(stdout, "State:       %s\n", run.State)
		fmt.Fprintf(stdout, "Repo:        %s\n", run.Repo)
		fmt.Fprintf(stdout, "Ref:         %s\n", run.Ref)
		fmt.Fprintf(stdout, "Domain:      %s\n", run.TrustDomain)
		fmt.Fprintf(stdout, "Created:     %s\n", run.CreatedAt.Format("2006-01-02 15:04:05 MST"))
		if run.StartedAt != nil {
			fmt.Fprintf(stdout, "Started:     %s\n", run.StartedAt.Format("2006-01-02 15:04:05 MST"))
		}
		if run.FinishedAt != nil {
			fmt.Fprintf(stdout, "Finished:    %s\n", run.FinishedAt.Format("2006-01-02 15:04:05 MST"))
		}
		if run.Reason != "" {
			fmt.Fprintf(stdout, "Reason:      %s\n", run.Reason)
		}

		jobs, err := db.Jobs(ctx, runID)
		if err != nil {
			fmt.Fprintf(stderr, "zeroci: list jobs: %v\n", err)
			return ExitInternal
		}

		fmt.Fprintln(stdout, "\nJobs:")
		tw := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "  NAME\tSTATE\tEXIT\tREASON")
		for _, j := range jobs {
			exitStr := "-"
			if j.ExitCode != nil {
				exitStr = fmt.Sprintf("%d", *j.ExitCode)
			}
			errStr := j.Reason
			if errStr == "" {
				errStr = "-"
			}
			fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\n", j.Name, j.State, exitStr, errStr)
		}
		_ = tw.Flush()
		return ExitOK
	}

	runs, err := db.ListRuns(ctx, store.RunFilter{Limit: limit})
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: list runs: %v\n", err)
		return ExitInternal
	}

	if len(runs) == 0 {
		fmt.Fprintln(stdout, "No runs found.")
		return ExitOK
	}

	tw := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "RUN ID\tSTATE\tREPO\tREF\tCREATED")
	for _, r := range runs {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n",
			r.ID, r.State, r.Repo, r.Ref, r.CreatedAt.Format("2006-01-02 15:04:05"))
	}
	_ = tw.Flush()
	return ExitOK
}
