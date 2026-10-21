// Package trigger decides whether a deploy trigger from the hub may deploy:
// the env must exist at the commit, the push branch must be listed there and,
// off the default branch, in the default branch's config too, the commit
// must be on it, the trigger trusted, and a paths filter must match the
// files changed since the last success. A retry trigger re-queues the
// commit's Failed or Interrupted run.
package trigger

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/deploy"
	"github.com/KCuppens/hookci/agent/internal/ids"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/store"
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

// permanentError marks a Handle error that deciding the trigger again
// would only repeat.
type permanentError struct{ err error }

func (e *permanentError) Error() string { return e.err.Error() }
func (e *permanentError) Unwrap() error { return e.err }

// Permanent marks err as one a retry cannot fix, such as a refused fetch
// token. Its message is err's.
func Permanent(err error) error { return &permanentError{err: err} }

// IsPermanent reports whether err, a Handle error, would recur on retry:
// a trigger without an env, an invalid .hookci.yml, a GitHub 4xx other
// than 401, 403, 408 and 429, or an error marked by Permanent. Network,
// GitHub 5xx and store failures are transient.
func IsPermanent(err error) bool {
	var p *permanentError
	return errors.As(err, &p)
}

// Intake decides deploy triggers and records accepted ones as queued
// deploy runs. The caller queues an accepted run once the hub has its
// accepted frame.
type Intake struct {
	Store *store.Store
	Refs  RefChecker
	// LoadConfig returns the repository configuration at ref, a sha or a branch.
	LoadConfig func(ctx context.Context, repo, ref string) (*config.Config, error)
	Clock      func() time.Time // nil means time.Now
	NewRunID   func() string    // nil means ids.NewRunID
}

// Handle decides t, a trigger with an env. A redelivered trigger gets the
// run it already created. Errors are GitHub or store failures; IsPermanent
// tells the ones deciding t again would repeat.
func (in *Intake) Handle(ctx context.Context, t protocol.Trigger) (Decision, error) {
	env := ""
	if t.Env != nil {
		env = *t.Env
	}
	if env == "" {
		return Decision{}, Permanent(fmt.Errorf("trigger: %s has no env", t.TriggerId))
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
		return rejected("deployments.%s: env not defined in .hookci.yml at %s", env, short(t.Sha)), nil
	}
	branch := strings.TrimPrefix(t.Ref, "refs/heads/")
	if dep.On.Push != branch {
		return rejected("deployments.%s.on.push: branch %s is not listed", env, branch), nil
	}
	// The pushed commit names its own deploy branch, so a branch other than
	// the default one must also be named by the default branch's config:
	// whoever can push a branch cannot make it deploy.
	if t.DefaultBranch == nil {
		return rejected("deployments.%s: the repository's default branch is unknown", env), nil
	}
	if def := *t.DefaultBranch; branch != def {
		trusted, err := in.LoadConfig(ctx, t.Repo, def)
		if err != nil {
			return Decision{}, fmt.Errorf("trigger: load config at %s: %w", def, err)
		}
		if trusted.Deployments[env].On.Push != branch {
			return rejected("deployments.%s.on.push: branch %s is not listed on %s", env, branch, def), nil
		}
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
// once the run's branch still holds the commit and the trigger is trusted:
// the hub counts only its own triggers, so a host-side `hookci retry` leaves
// the agent's attempt ahead of it. The daemon drops a trigger id it already
// answered. The paths filter does not apply to a retry.
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
	return truncated || deploy.MatchPaths(globs, files), nil
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
