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
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/runstats"
)

const runsUsage = `usage: zeroci [global flags] runs <command> [--state-dir DIR | --installation ID]

Export the finished check and deploy runs of the agent database, and report
their median and p90 durations and the runner money saved against a hosted
CI baseline. Durations are the agent's recorded start to finish; hub queue
time is excluded.

  runs export --since RFC3339 [--until RFC3339] [--kind check|deploy] [--repo OWNER/NAME] [--format jsonl]
      Writes one JSON run record per line to stdout.
  runs stats (--input FILE.jsonl | --since RFC3339 [--repo OWNER/NAME]) [--until RFC3339]
             --baseline-check SECONDS --baseline-deploy SECONDS --price-per-minute USD [--markdown]
      Prints the report as JSON, or as Markdown with --markdown. With --input
      the window defaults to the first start and last finish in the file. A
      window under one day gets no monthly projection.
`

// cmdRuns exports finished runs and reports their stats. Usage errors exit
// 2, store and I/O failures 4.
func cmdRuns(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, runsUsage)
		return ExitUsage
	}
	switch args[0] {
	case "export":
		return runsExport(ctx, d, args[1:], stdout, stderr)
	case "stats":
		return runsStats(ctx, d, args[1:], stdout, stderr)
	case "help", "-h", "--help":
		fmt.Fprint(stderr, runsUsage)
		return ExitOK
	default:
		fmt.Fprintf(stderr, "zeroci: runs: unknown command %q\n", args[0])
		fmt.Fprint(stderr, runsUsage)
		return ExitUsage
	}
}

// runsFlags is the flag set of one runs command with the flags that pick
// the agent database and the window.
type runsFlags struct {
	*flag.FlagSet
	stateDir     *string
	installation *int64
	since, until *string
	repo         *string
}

func newRunsFlags(d Deps, usage string, stderr io.Writer) *runsFlags {
	fs := flag.NewFlagSet("runs", flag.ContinueOnError)
	fs.SetOutput(stderr)
	f := &runsFlags{
		FlagSet:      fs,
		stateDir:     fs.String("state-dir", d.Globals.StateDir, "agent state directory, as given to zeroci connect"),
		installation: fs.Int64("installation", 0, "use the agent of this installation in "+defaultStateRoot+"/<ID>"),
		since:        fs.String("since", "", "first finish time to include, RFC3339"),
		until:        fs.String("until", "", "last finish time to include, RFC3339"),
		repo:         fs.String("repo", "", "only runs of this repo (OWNER/NAME)"),
	}
	fs.Usage = func() {
		fmt.Fprintf(stderr, "usage: zeroci [global flags] runs %s [--state-dir DIR | --installation ID]\n", usage)
		fs.PrintDefaults()
	}
	return f
}

// parse parses args, which take no positional arguments. When ok is false
// the command ends with code.
func (f *runsFlags) parse(args []string, stderr io.Writer) (code int, ok bool) {
	pos, err := parseInterleaved(f.FlagSet, args)
	if errors.Is(err, flag.ErrHelp) {
		return ExitOK, false
	}
	if err != nil {
		return ExitUsage, false
	}
	if len(pos) != 0 {
		f.Usage()
		return ExitUsage, false
	}
	if *f.installation < 0 {
		fmt.Fprintln(stderr, "zeroci: --installation must be a positive installation id")
		return ExitUsage, false
	}
	if *f.installation > 0 {
		*f.stateDir = filepath.Join(defaultStateRoot, strconv.FormatInt(*f.installation, 10))
	}
	return ExitOK, true
}

// window parses --since and --until. A missing --since is the zero time and
// a missing --until is now.
func (f *runsFlags) window(d Deps) (since, until time.Time, err error) {
	if *f.since != "" {
		if since, err = time.Parse(time.RFC3339, *f.since); err != nil {
			return since, until, fmt.Errorf("--since: %w", err)
		}
	}
	until = d.Clock()
	if *f.until != "" {
		if until, err = time.Parse(time.RFC3339, *f.until); err != nil {
			return since, until, fmt.Errorf("--until: %w", err)
		}
	}
	if until.Before(since) {
		return since, until, fmt.Errorf("--until %s is before --since %s", until.Format(time.RFC3339), since.Format(time.RFC3339))
	}
	return since, until, nil
}

// list reads the finished runs of the agent database. A state dir without a
// database has no runs.
func (f *runsFlags) list(ctx context.Context, d Deps, since, until time.Time, kind string) ([]runstats.RunRecord, error) {
	d.Globals.StateDir = *f.stateDir
	st, err := openStateStore(d)
	if err != nil || st == nil {
		return nil, err
	}
	defer st.Close()
	return st.ListFinishedRuns(ctx, since, until, kind, *f.repo)
}

func runsExport(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	f := newRunsFlags(d, "export --since RFC3339 [--until RFC3339] [--kind check|deploy] [--repo OWNER/NAME] [--format jsonl]", stderr)
	kind := f.String("kind", "", "only runs of this kind: check or deploy")
	format := f.String("format", "jsonl", "output format; only jsonl")
	if code, ok := f.parse(args, stderr); !ok {
		return code
	}
	if *f.since == "" {
		fmt.Fprintln(stderr, "zeroci: runs export: --since is required")
		return ExitUsage
	}
	if *kind != "" && *kind != runstats.KindCheck && *kind != runstats.KindDeploy {
		fmt.Fprintf(stderr, "zeroci: runs export: --kind must be check or deploy, not %q\n", *kind)
		return ExitUsage
	}
	if *format != "jsonl" {
		fmt.Fprintf(stderr, "zeroci: runs export: --format must be jsonl, not %q\n", *format)
		return ExitUsage
	}
	since, until, err := f.window(d)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: runs export: %v\n", err)
		return ExitUsage
	}
	runs, err := f.list(ctx, d, since, until, *kind)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: runs export: %v\n", err)
		return ExitInternal
	}
	enc := json.NewEncoder(stdout)
	for _, r := range runs {
		if err := enc.Encode(r); err != nil {
			fmt.Fprintf(stderr, "zeroci: runs export: %v\n", err)
			return ExitInternal
		}
	}
	return ExitOK
}

func runsStats(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	f := newRunsFlags(d, "stats (--input FILE.jsonl | --since RFC3339 [--repo OWNER/NAME]) [--until RFC3339] "+
		"--baseline-check SECONDS --baseline-deploy SECONDS --price-per-minute USD [--markdown]", stderr)
	input := f.String("input", "", "JSONL file written by zeroci runs export, instead of the agent database")
	var b runstats.Baseline
	f.Float64Var(&b.CheckSeconds, "baseline-check", 0, "wall seconds of one check run on the hosted CI baseline")
	f.Float64Var(&b.DeploySeconds, "baseline-deploy", 0, "wall seconds of one deploy run on the hosted CI baseline")
	f.Float64Var(&b.PricePerMinuteUSD, "price-per-minute", 0, "USD the hosted CI baseline bills per runner minute")
	markdown := f.Bool("markdown", false, "print the report as Markdown instead of JSON")
	if code, ok := f.parse(args, stderr); !ok {
		return code
	}
	switch {
	case b.PricePerMinuteUSD <= 0:
		fmt.Fprintln(stderr, "zeroci: runs stats: --price-per-minute is required: the USD the hosted CI baseline bills per runner minute")
		return ExitUsage
	case b.CheckSeconds <= 0 || b.DeploySeconds <= 0:
		fmt.Fprintln(stderr, "zeroci: runs stats: --baseline-check and --baseline-deploy are required: the seconds one check and one deploy take on the hosted CI baseline")
		return ExitUsage
	case *input == "" && *f.since == "":
		fmt.Fprintln(stderr, "zeroci: runs stats: give --input FILE.jsonl or --since RFC3339")
		return ExitUsage
	case *input != "" && *f.repo != "":
		fmt.Fprintln(stderr, "zeroci: runs stats: --repo filters the agent database; export one repo to the --input file instead")
		return ExitUsage
	}
	since, until, err := f.window(d)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: runs stats: %v\n", err)
		return ExitUsage
	}
	var runs []runstats.RunRecord
	if *input != "" {
		runs, err = readRunsFile(*input)
		if err != nil {
			fmt.Fprintf(stderr, "zeroci: runs stats: %v\n", err)
			return ExitInternal
		}
		since, until = inputWindow(runs, since, until, *f.since != "", *f.until != "")
	} else if runs, err = f.list(ctx, d, since, until, ""); err != nil {
		fmt.Fprintf(stderr, "zeroci: runs stats: %v\n", err)
		return ExitInternal
	}
	rep := runstats.Compute(runs, b, since, until)
	if *markdown {
		fmt.Fprint(stdout, rep.Markdown())
		return ExitOK
	}
	return writeJSON(stdout, stderr, rep)
}

func readRunsFile(path string) ([]runstats.RunRecord, error) {
	fh, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	runs, err := runstats.ReadJSONL(fh)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return runs, nil
}

// inputWindow replaces the window ends not given as flags with the first
// start and the last finish of runs.
func inputWindow(runs []runstats.RunRecord, since, until time.Time, haveSince, haveUntil bool) (time.Time, time.Time) {
	var first, last time.Time
	for _, r := range runs {
		if first.IsZero() || r.StartedAt.Before(first) {
			first = r.StartedAt
		}
		if r.FinishedAt.After(last) {
			last = r.FinishedAt
		}
	}
	if !haveSince {
		since = first
	}
	if !haveUntil {
		until = last
	}
	return since, until
}
