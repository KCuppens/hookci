package daemon

import (
	"context"
	"fmt"
	"strings"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/deploy"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// lastSuccessScan bounds how many recent successful runs of a repository are
// searched for the previous good run of a branch.
const lastSuccessScan = 200

// usesPaths reports whether any job of checks restricts itself by paths.
func usesPaths(checks *config.ResolvedChecks) bool {
	for _, j := range checks.Jobs {
		if len(j.Paths) > 0 {
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
	if !usesPaths(checks) || d.changes == nil {
		return nil
	}
	files, ok, err := d.changedFiles(w.ctx, w.trig, w.runID)
	if err != nil {
		d.log.Warn("list changed files failed; running every job", "run", w.runID, "err", err)
		return nil
	}
	if !ok {
		return nil
	}
	return skipByPaths(checks, files)
}

// skipByPaths decides, for the scheduler, which jobs a run skips: those whose
// paths match none of files.
func skipByPaths(checks *config.ResolvedChecks, files []string) func(store.Run, string) (string, bool) {
	paths := make(map[string][]string, len(checks.Jobs))
	for _, j := range checks.Jobs {
		if len(j.Paths) > 0 {
			paths[j.Name] = j.Paths
		}
	}
	return func(run store.Run, name string) (string, bool) {
		globs := paths[name]
		if run.Kind == kindDeploy || len(globs) == 0 || deploy.MatchPaths(globs, files) {
			return "", false
		}
		return "no changed file matches paths (" + strings.Join(globs, ", ") + ")", true
	}
}
