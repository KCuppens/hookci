package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"

	"github.com/KCuppens/hookci/agent/internal/control"
	"github.com/KCuppens/hookci/agent/internal/gc"
)

// cmdGC asks the running agent for a GC pass over its deploy images, build
// cache, run dirs and setup step cache entries, and prints what it removed
// or, with --dry-run, would remove.
func cmdGC(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("gc", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dryRun := fs.Bool("dry-run", false, "print what would be removed without removing it")
	dirFlags := addStateDirFlags(fs, d)
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: hookci [global flags] gc [--dry-run] [--state-dir DIR | --installation ID]")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "Remove old deploy images, cap the build cache, delete finished run dirs and evict old cache entries.")
		fs.PrintDefaults()
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
	stateDir, ok := dirFlags.resolve(stderr)
	if !ok {
		return ExitUsage
	}

	var rep gc.Report
	err = control.Call(ctx, stateDir, "gc", gc.Request{DryRun: *dryRun}, &rep)
	if errors.Is(err, control.ErrNotRunning) {
		fmt.Fprintf(stderr, "hookci: no agent is running on %s; start it with systemctl start hookci-agent@<installation>\n", stateDir)
		return ExitInternal
	}
	if err != nil {
		fmt.Fprintf(stderr, "hookci: gc: %v\n", err)
		return ExitInternal
	}
	return printGCReport(rep, stdout, stderr)
}

// printGCReport prints one line per image, run dir and cache entry, the
// build cache cap and every skipped env and failure. Failures make it return
// ExitInternal.
func printGCReport(rep gc.Report, stdout, stderr io.Writer) int {
	p := rep.Plan
	images, dirs, entries, pruned := p.RemoveImages, p.RemoveRunDirs, p.RemoveCacheEntries, p.PruneBuildCache
	verb, prune := "would remove", "would cap build cache:"
	var failures []string
	if !rep.DryRun {
		if rep.Result == nil {
			fmt.Fprintln(stderr, "hookci: gc: agent sent no result")
			return ExitInternal
		}
		r := rep.Result
		images, dirs, entries, pruned, failures = r.RemovedImages, r.RemovedRunDirs, r.RemovedCacheEntries, r.PrunedBuildCache, r.Errors
		verb, prune = "removed", "capped build cache:"
	}
	for _, ref := range images {
		fmt.Fprintf(stdout, "%s image %s\n", verb, ref)
	}
	if pruned {
		fmt.Fprintf(stdout, "%s %s %d\n", prune, p.PruneFlag, p.KeepStorageBytes)
	}
	for _, dir := range dirs {
		fmt.Fprintf(stdout, "%s run dir %s\n", verb, dir)
	}
	for _, e := range entries {
		fmt.Fprintf(stdout, "%s cache entry %s\n", verb, e)
	}
	for _, env := range p.SkippedEnvs {
		fmt.Fprintf(stdout, "skipped %s\n", env)
	}
	for _, f := range failures {
		fmt.Fprintf(stderr, "hookci: gc: %s\n", f)
	}
	if len(failures) > 0 {
		return ExitInternal
	}
	return ExitOK
}
