// Package trigger decides whether a deploy trigger from the hub may deploy:
// the env must exist at the commit, the push branch must be listed and
// protected on GitHub, the commit must be on it, the trigger trusted, and a
// paths filter must match the files changed since the last success. A
// retry trigger re-queues the commit's Failed or Interrupted run.
package trigger

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/ids"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// Decision is the answer to a deploy trigger: accepted for RunID, or
// rejected with Reason. Retry marks an accepted run the caller queues as a
// retry of a Failed or Interrupted run.
type Decision struct {
	Accepted bool
	RunID    string
	Reason   string
	Retry    bool
}

// Intake decides deploy triggers and records accepted ones as queued
// deploy runs. The caller queues an accepted run once the hub has its
// accepted frame.
type Intake struct {
	Store *store.Store
	Refs  RefChecker
	// LoadConfig returns the repository configuration at sha.
	LoadConfig func(ctx context.Context, repo, sha string) (*config.Config, error)
	Clock      func() time.Time // nil means time.Now
	NewRunID   func() string    // nil means ids.NewRunID
}

// Handle decides t, a trigger with an env. A redelivered trigger gets the
// run it already created. Errors are GitHub or store failures; the hub may
// redeliver the trigger after them.
func (in *Intake) Handle(ctx context.Context, t protocol.Trigger) (Decision, error) {
	env := ""
	if t.Env != nil {
		env = *t.Env
	}
	if env == "" {
		return Decision{}, fmt.Errorf("trigger: %s has no env", t.TriggerId)
	}
	switch t.Event {
	case protocol.TriggerEventPush:
	case protocol.TriggerEventRetry:
		return in.handleRetry(ctx, t, env)
	default:
		return rejected("deploys run only from push or retry, got %s", t.Event), nil
	}

	run, err := in.Store.FindDeployRun(ctx, t.Repo, env, t.Sha, t.Attempt)
	if err == nil {
		return Decision{Accepted: true, RunID: run.RunID}, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return Decision{}, fmt.Errorf("trigger: %w", err)
	}

	cfg, err := in.LoadConfig(ctx, t.Repo, t.Sha)
	if err != nil {
		return Decision{}, fmt.Errorf("trigger: load config: %w", err)
	}
	dep, ok := cfg.Deployments[env]
	if !ok {
		return rejected("deployments.%s: env not defined in .zeroci.yml at %s", env, short(t.Sha)), nil
	}
	branch := strings.TrimPrefix(t.Ref, "refs/heads/")
	if dep.On.Push != branch {
		return rejected("deployments.%s.on.push: branch %s is not listed", env, branch), nil
	}
	protected, err := in.Refs.IsProtected(ctx, t.Repo, branch)
	if err != nil {
		return Decision{}, fmt.Errorf("trigger: %w", err)
	}
	if !protected {
		return rejected("deployments.%s: branch %s is not protected on GitHub; protect it or remove the env", env, branch), nil
	}
	onRef, err := in.Refs.ContainsSHA(ctx, t.Repo, branch, t.Sha)
	if err != nil {
		return Decision{}, fmt.Errorf("trigger: %w", err)
	}
	if !onRef {
		return rejected("deployments.%s: %s is not on %s", env, short(t.Sha), branch), nil
	}
	if t.Trust != protocol.TriggerTrustTrusted {
		return rejected("deployments.%s: untrusted trigger cannot deploy", env), nil
	}
	if len(dep.Paths) > 0 {
		match, err := in.pathsMatch(ctx, t, env, dep.Paths)
		if err != nil {
			return Decision{}, err
		}
		if !match {
			return rejected("deployments.%s.paths: no changed file matches", env), nil
		}
	}

	runID := in.newRunID()
	if err := in.Store.InsertDeployRun(ctx, store.DeployRun{
		RunID: runID, Repo: t.Repo, Env: env, SHA: t.Sha, Ref: t.Ref,
		Strategy: string(dep.Strategy), Attempt: t.Attempt, State: store.DeployQueued,
		CreatedAt: in.now(),
	}); err != nil {
		return Decision{}, fmt.Errorf("trigger: %w", err)
	}
	return Decision{Accepted: true, RunID: runID}, nil
}

// handleRetry answers a retry trigger for the newest run of env at t.Sha.
// A trigger at that run's attempt is a redelivery and gets the run while it
// is not Failed or Interrupted. A trigger at the run's attempt or later
// re-queues a Failed or Interrupted run as a retry under the same run id,
// once the run's branch is still protected, holds the commit and the
// trigger is trusted: the hub counts only its own triggers, so a host-side
// `zeroci retry` leaves the agent's attempt ahead of it. The daemon drops a
// trigger id it already answered. The paths filter does not apply to a retry.
func (in *Intake) handleRetry(ctx context.Context, t protocol.Trigger, env string) (Decision, error) {
	run, err := in.Store.LatestDeployRunFor(ctx, t.Repo, env, t.Sha)
	if errors.Is(err, store.ErrNotFound) {
		return rejected("nothing to retry for %s at %s", env, short(t.Sha)), nil
	}
	if err != nil {
		return Decision{}, fmt.Errorf("trigger: %w", err)
	}
	stale := rejected("nothing to retry for %s at %s (attempt %d)", env, short(t.Sha), t.Attempt)
	retryable := deploy.Retryable(run.State)
	if run.Attempt == t.Attempt && !retryable {
		return Decision{Accepted: true, RunID: run.RunID, Retry: run.RetryOfState != ""}, nil
	}
	if t.Attempt < run.Attempt || !retryable {
		return stale, nil
	}
	branch := strings.TrimPrefix(run.Ref, "refs/heads/")
	protected, err := in.Refs.IsProtected(ctx, t.Repo, branch)
	if err != nil {
		return Decision{}, fmt.Errorf("trigger: %w", err)
	}
	if !protected {
		return rejected("deployments.%s: branch %s is not protected on GitHub; protect it or remove the env", env, branch), nil
	}
	onRef, err := in.Refs.ContainsSHA(ctx, t.Repo, branch, t.Sha)
	if err != nil {
		return Decision{}, fmt.Errorf("trigger: %w", err)
	}
	if !onRef {
		return rejected("deployments.%s: %s is not on %s", env, short(t.Sha), branch), nil
	}
	if t.Trust != protocol.TriggerTrustTrusted {
		return rejected("deployments.%s: untrusted trigger cannot deploy", env), nil
	}
	if _, err := deploy.PrepareRetry(ctx, in.Store, run.RunID); err != nil {
		if errors.Is(err, deploy.ErrNotRetryable) {
			return stale, nil
		}
		return Decision{}, fmt.Errorf("trigger: %w", err)
	}
	return Decision{Accepted: true, RunID: run.RunID, Retry: true}, nil
}

// pathsMatch reports whether the files changed since the env's last
// successful deploy match globs. With no last success, or a change list
// GitHub truncated, every push matches.
func (in *Intake) pathsMatch(ctx context.Context, t protocol.Trigger, env string, globs []string) (bool, error) {
	st, ok, err := in.Store.GetDeployState(ctx, t.Repo, env)
	if err != nil {
		return false, fmt.Errorf("trigger: %w", err)
	}
	if !ok || st.LastSuccessSHA == "" {
		return true, nil
	}
	files, truncated, err := in.Refs.ChangedFiles(ctx, t.Repo, st.LastSuccessSHA, t.Sha)
	if err != nil {
		return false, fmt.Errorf("trigger: %w", err)
	}
	return truncated || MatchPaths(globs, files), nil
}

func (in *Intake) now() time.Time {
	if in.Clock == nil {
		return time.Now()
	}
	return in.Clock()
}

func (in *Intake) newRunID() string {
	if in.NewRunID == nil {
		return ids.NewRunID()
	}
	return in.NewRunID()
}

func rejected(format string, args ...any) Decision {
	return Decision{Reason: fmt.Sprintf(format, args...)}
}

// short is the 7-character abbreviation of sha.
func short(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}
