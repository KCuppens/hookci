package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/KCuppens/zerocideploy/agent/internal/cache"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/detect"
	"github.com/KCuppens/zerocideploy/agent/internal/executor"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/ids"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/recovery"
	"github.com/KCuppens/zerocideploy/agent/internal/scheduler"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
	"github.com/KCuppens/zerocideploy/agent/internal/sink"
	"github.com/KCuppens/zerocideploy/agent/internal/source"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// runNoChecksMessage is printed when run finds neither a .zeroci.yml nor a
// detectable project with checks.
const runNoChecksMessage = "zeroci: no checks detected. Add a .zeroci.yml or run zeroci init."

// cmdRun runs the checks of the committed HEAD of the repo around the
// working directory, or one job and its transitive needs.
func cmdRun(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: zeroci [global flags] run [job]")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "Run the checks of the current repo's committed HEAD, or one job and the jobs it needs.")
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
	g := d.Globals

	if err := os.MkdirAll(g.StateDir, 0o700); err != nil {
		fmt.Fprintf(stderr, "zeroci: create state directory: %v\n", err)
		return ExitInternal
	}
	unlock, err := lockStateDir(g.StateDir)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %s: %v\n", g.StateDir, err)
		return ExitInternal
	}
	defer unlock()

	db, err := store.Open(filepath.Join(g.StateDir, "agent.db"), store.WithClock(d.Clock))
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: open store: %v\n", err)
		return ExitInternal
	}
	defer db.Close()

	iso, warnings, err := d.Isolation(g.Isolation)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitUsage
	}
	for _, w := range warnings {
		fmt.Fprintf(stderr, "zeroci: warning: %s\n", w)
	}
	runAs, err := isolation.JobCredential(iso)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	jobUser := executor.JobUser{Cred: runAs}

	// Units left by an earlier systemd run must be found even when this run
	// uses none, so the sweep uses systemd whenever the host can run it.
	recIso := iso
	if sd, _, err := d.Isolation("systemd"); err == nil {
		recIso = sd
	}
	report, err := recovery.Recover(ctx, recovery.Deps{
		Store:     db,
		Isolation: recIso,
		Netns:     recovery.NetnsManager{Manager: d.Netns},
		Docker:    services.Docker{Runner: d.Host},
		Runner:    d.Host,
		Logger:    slog.New(slog.DiscardHandler),
	})
	for _, e := range report.Errors {
		fmt.Fprintf(stderr, "zeroci: warning: recovery: %v\n", e)
	}
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: recovery: %v\n", err)
		return ExitInternal
	}

	wd, err := d.Getwd()
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	runID := ids.NewRunID()
	dir, err := executor.NewRunDir(g.StateDir, runID, jobUser)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	git := source.Git{Runner: execx.OS{}}
	local := &source.Local{Git: git, Dir: wd, Mirrors: source.NewMirrors(filepath.Join(g.StateDir, "mirrors"), git), Warn: stderr}
	co, err := local.Checkout(ctx, source.Request{Ref: "HEAD", RunAs: runAs}, dir.Src())
	if err != nil {
		os.RemoveAll(dir.Root)
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		if errors.Is(err, source.ErrNotGitRepo) {
			return ExitUsage
		}
		return ExitInternal
	}
	defer co.Release()

	checks, code := loadChecks(dir.Src(), stderr)
	if code == ExitOK && len(pos) == 1 {
		checks, code = onlyJob(checks, pos[0], stderr)
	}
	if code != ExitOK {
		os.RemoveAll(dir.Root)
		return code
	}

	attempt, err := nextLocalAttempt(ctx, db, co.Repo, co.SHA)
	if err != nil {
		os.RemoveAll(dir.Root)
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	jobs := make([]store.Job, 0, len(checks.Jobs))
	for _, j := range checks.Jobs {
		jobs = append(jobs, store.Job{Name: j.Name, Needs: j.Needs})
	}
	run := store.Run{
		ID:          runID,
		Repo:        co.Repo,
		SHA:         co.SHA,
		Ref:         co.Ref,
		Event:       "local",
		Attempt:     attempt,
		Kind:        "check",
		TrustDomain: "trusted:" + co.Repo,
	}
	if err := db.CreateRun(ctx, run, jobs); err != nil {
		os.RemoveAll(dir.Root)
		fmt.Fprintf(stderr, "zeroci: create run: %v\n", err)
		return ExitInternal
	}

	hooks := d.Hooks
	if hooks.Netns == nil {
		hooks.Netns = d.Netns
	}
	if hooks.Cache == nil {
		if c, err := cache.New(cache.Options{Root: filepath.Join(g.StateDir, "cache")}); err != nil {
			fmt.Fprintf(stderr, "zeroci: warning: caches disabled: %v\n", err)
		} else {
			hooks.Cache = c
		}
	}
	var mirror io.Writer
	if g.Verbose {
		mirror = stdout
	}
	ex, err := executor.New(executor.Options{
		StateDir:  g.StateDir,
		Store:     db,
		Isolation: iso,
		JobUser:   jobUser,
		Source:    checkedOut(co),
		Config: func(store.Run, string) (*config.ResolvedChecks, error) {
			return checks, nil
		},
		Hooks:  hooks,
		Clock:  d.Clock,
		Mirror: mirror,
	})
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}

	pump := &sink.Pump{
		Store: db,
		Sink:  sink.NewStdout(sink.StdoutOptions{Out: stdout, Color: colorEnabled(stdout), Clock: d.Clock, Verbose: g.Verbose}),
	}
	pumpCtx, stopPump := context.WithCancel(context.WithoutCancel(ctx))
	pumpErr := make(chan error, 1)
	go func() { pumpErr <- pump.Run(pumpCtx) }()

	runErr := driveRun(ctx, scheduler.New(db, ex, scheduler.Options{Slots: g.Slots}), runID)

	// Run drains the outbox once more before it returns.
	stopPump()
	if err := <-pumpErr; err != nil {
		fmt.Fprintf(stderr, "zeroci: print run progress: %v\n", err)
	}
	if runErr != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", runErr)
		return ExitInternal
	}

	final, err := db.GetRun(context.WithoutCancel(ctx), runID)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	if final.State == store.RunSuccess {
		return ExitOK
	}
	if final.Reason != "" {
		fmt.Fprintf(stderr, "zeroci: run %s: %s\n", final.State, final.Reason)
	}
	return ExitRunFailed
}

// driveRun submits runID to sched and waits for it to end. When ctx ends
// first (SIGINT, SIGTERM) the run is cancelled and waited for, so its
// teardown completes before sched closes.
func driveRun(ctx context.Context, sched *scheduler.Scheduler, runID string) error {
	defer sched.Close()
	if _, err := sched.Submit(ctx, runID); err != nil {
		return err
	}
	_, err := sched.Wait(ctx, runID)
	if err == nil || ctx.Err() == nil {
		return err
	}
	bg := context.WithoutCancel(ctx)
	if err := sched.Cancel(bg, runID, "interrupted by signal"); err != nil {
		return err
	}
	_, err = sched.Wait(bg, runID)
	return err
}

// loadChecks loads <src>/.zeroci.yml, or detects the checks of src when it
// has none. Config errors return ExitUsage; finding no jobs returns
// ExitNoChecks.
func loadChecks(src string, stderr io.Writer) (*config.ResolvedChecks, int) {
	path := filepath.Join(src, ".zeroci.yml")
	var cfg *config.Config
	switch _, err := os.Stat(path); {
	case err == nil:
		loaded, diags, err := config.Load(path, config.ParseOptions{})
		if err != nil {
			fmt.Fprintf(stderr, "zeroci: load .zeroci.yml: %v\n", err)
			return nil, ExitUsage
		}
		if len(diags) > 0 {
			fmt.Fprint(stderr, diags.Format(".zeroci.yml"))
		}
		if diags.HasErrors() {
			return nil, ExitUsage
		}
		cfg = loaded
	case errors.Is(err, os.ErrNotExist):
		det, err := detect.DetectDir(src)
		if errors.Is(err, detect.ErrNothingDetected) {
			fmt.Fprintln(stderr, runNoChecksMessage)
			return nil, ExitNoChecks
		}
		if err != nil {
			fmt.Fprintf(stderr, "zeroci: %v\n", err)
			return nil, ExitUsage
		}
		cfg = det.Config
	default:
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return nil, ExitInternal
	}
	checks := cfg.Checks()
	if checks == nil || len(checks.Jobs) == 0 {
		// Detection can find an ecosystem (e.g. Python setup) without jobs.
		fmt.Fprintln(stderr, runNoChecksMessage)
		return nil, ExitNoChecks
	}
	return checks, ExitOK
}

// onlyJob keeps job name and its transitive needs, in plan order.
func onlyJob(checks *config.ResolvedChecks, name string, stderr io.Writer) (*config.ResolvedChecks, int) {
	byName := make(map[string]config.ResolvedJob, len(checks.Jobs))
	names := make([]string, 0, len(checks.Jobs))
	for _, j := range checks.Jobs {
		byName[j.Name] = j
		names = append(names, j.Name)
	}
	if _, ok := byName[name]; !ok {
		fmt.Fprintf(stderr, "zeroci: unknown job %q (jobs: %s)\n", name, strings.Join(names, ", "))
		return nil, ExitUsage
	}
	keep := map[string]bool{}
	stack := []string{name}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if keep[n] {
			continue
		}
		keep[n] = true
		stack = append(stack, byName[n].Needs...)
	}
	only := *checks
	only.Jobs = slices.DeleteFunc(slices.Clone(checks.Jobs), func(j config.ResolvedJob) bool { return !keep[j.Name] })
	return &only, ExitOK
}

// nextLocalAttempt numbers a new local run of repo at sha after the earlier
// ones, which keeps the store's (repo, sha, event, env, attempt) key unique.
func nextLocalAttempt(ctx context.Context, db *store.Store, repo, sha string) (int, error) {
	runs, err := db.ListRuns(ctx, store.RunFilter{Repo: repo})
	if err != nil {
		return 0, err
	}
	attempt := 1
	for _, r := range runs {
		if r.SHA == sha && r.Event == "local" && r.Env == "" && r.Attempt >= attempt {
			attempt = r.Attempt + 1
		}
	}
	return attempt, nil
}

// checkedOut is the executor Source of a run cmdRun has already checked out.
type checkedOut source.Checkout

func (c checkedOut) Name() string { return "local" }

func (c checkedOut) Checkout(_ context.Context, _ source.Request, dir string) (source.Checkout, error) {
	if dir != c.Dir {
		return source.Checkout{}, fmt.Errorf("cli: run is checked out in %s, not %s", c.Dir, dir)
	}
	return source.Checkout(c), nil
}

// parseInterleaved parses fs flags placed anywhere in args and returns the
// positional arguments in order.
func parseInterleaved(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if fs.NArg() == 0 {
			return pos, nil
		}
		pos = append(pos, fs.Arg(0))
		args = fs.Args()[1:]
	}
}

// colorEnabled reports whether run progress written to w may use colors.
func colorEnabled(w io.Writer) bool {
	f, ok := w.(*os.File)
	return ok && sink.ColorEnabled(f, os.Getenv)
}
