package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/deploy"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// lastSuccessScan bounds how many recent successful runs of a repository are
// searched for the previous good run of a branch.
const lastSuccessScan = 200

// usesPaths reports whether any job or setup step of checks restricts itself
// by paths.
func usesPaths(checks *config.ResolvedChecks) bool {
	for _, j := range checks.Jobs {
		if len(j.Paths) > 0 {
			return true
		}
	}
	for _, s := range checks.Setup {
		if len(s.Paths) > 0 {
			return true
		}
	}
	return false
}

// changedFiles lists the files the run of t changes: a pull request against
// its base commit, a push since the branch's last successful check run. ok is
// false when they cannot be told (no earlier success, a truncated GitHub
// answer); the caller then runs every job.
func (d *Daemon) changedFiles(ctx context.Context, t protocol.Trigger, runID string) (files []string, ok bool, err error) {
	var base string
	if t.Pr != nil {
		if t.BaseSha == nil || *t.BaseSha == "" {
			return nil, false, nil
		}
		base = *t.BaseSha
	} else {
		runs, err := d.st.ListRuns(ctx, store.RunFilter{Repo: t.Repo, States: []store.RunState{store.RunSuccess}, Limit: lastSuccessScan})
		if err != nil {
			return nil, false, fmt.Errorf("list runs: %w", err)
		}
		for _, r := range runs {
			if r.Kind != kindDeploy && r.PR == nil && r.Ref == t.Ref && r.SHA != t.Sha {
				base = r.SHA
				break
			}
		}
		if base == "" {
			return nil, false, nil
		}
	}
	files, truncated, err := d.changes(runID).ChangedFiles(ctx, t.Repo, base, t.Sha)
	if err != nil {
		return nil, false, err
	}
	if truncated {
		return nil, false, nil
	}
	return files, true, nil
}

// jobSkipper returns the scheduler's Skip hook for w, or nil when every job
// runs: no job sets paths, or the changed files are unknown (a failure is
// logged, never fatal).
func (d *Daemon) jobSkipper(w *work, checks *config.ResolvedChecks) func(store.Run, string) (string, bool) {
	_, skip := d.applyPaths(w, checks)
	return skip
}

// applyPaths lists the run's changed files once and returns checks without
// the setup steps whose paths match none of them, and the scheduler's Skip
// hook for jobs. checks is not modified. When no path is set or the files
// are unknown it returns checks and a nil hook: everything runs.
func (d *Daemon) applyPaths(w *work, checks *config.ResolvedChecks) (*config.ResolvedChecks, func(store.Run, string) (string, bool)) {
	if !usesPaths(checks) || d.changes == nil {
		return checks, nil
	}
	files, ok, err := d.changedFiles(w.ctx, w.trig, w.runID)
	if err != nil {
		d.log.Warn("list changed files failed; running every job and setup step", "run", w.runID, "err", err)
		return checks, nil
	}
	if !ok {
		return checks, nil
	}
	return skipSetupSteps(checks, files, d.log, w.runID), skipByPaths(checks, files)
}

// skipSetupSteps returns checks with the plain setup steps dropped whose
// paths match none of files. A dropped step neither runs nor touches its
// cache. Steps with for stay: they are jobs, which skipByPaths settles.
func skipSetupSteps(checks *config.ResolvedChecks, files []string, log *slog.Logger, runID string) *config.ResolvedChecks {
	keep := make([]config.SetupStep, 0, len(checks.Setup))
	for i, s := range checks.Setup {
		if len(s.For) == 0 && len(s.Paths) > 0 && !deploy.MatchPaths(s.Paths, files) {
			log.Info("setup step skipped: no changed file matches paths", "run", runID, "step", i, "paths", s.Paths)
			continue
		}
		keep = append(keep, s)
	}
	if len(keep) == len(checks.Setup) {
		return checks
	}
	out := *checks
	out.Setup = keep
	return &out
}

// skipByPaths decides, for the scheduler, which jobs a run skips: those whose
// paths match none of files. A deferred setup job is skipped when its own
// paths match none, or when every job it is for is skipped.
func skipByPaths(checks *config.ResolvedChecks, files []string) func(store.Run, string) (string, bool) {
	paths := make(map[string][]string, len(checks.Jobs))
	for _, j := range checks.Jobs {
		if len(j.Paths) > 0 {
			paths[j.Name] = j.Paths
		}
	}
	jobSkipped := func(name string) bool {
		globs := paths[name]
		return len(globs) > 0 && !deploy.MatchPaths(globs, files)
	}
	deferred := make(map[string]config.DeferredStep)
	for _, d := range config.DeferredSteps(checks.Setup) {
		deferred[d.Name] = d
	}
	return func(run store.Run, name string) (string, bool) {
		if run.Kind == kindDeploy {
			return "", false
		}
		if d, ok := deferred[name]; ok {
			if len(d.Step.Paths) > 0 && !deploy.MatchPaths(d.Step.Paths, files) {
				return "no changed file matches paths (" + strings.Join(d.Step.Paths, ", ") + ")", true
			}
			for _, job := range d.Step.For {
				if !jobSkipped(job) {
					return "", false
				}
			}
			return "every job it is for was skipped", true
		}
		if jobSkipped(name) {
			return "no changed file matches paths (" + strings.Join(paths[name], ", ") + ")", true
		}
		return "", false
	}
}
