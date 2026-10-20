package daemon

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/trigger"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/hubtokens"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
)

// DeployIntake decides deploy triggers, the triggers that name an env.
type DeployIntake interface {
	Handle(ctx context.Context, t protocol.Trigger) (trigger.Decision, error)
}

// githubTimeout bounds each GitHub call a deploy check makes.
const githubTimeout = 30 * time.Second

// deployAttempts is how many times a deploy trigger is decided when its
// checks keep failing transiently. The wait before the next attempt starts
// at deployRetryBase and doubles up to deployRetryMax.
const (
	deployAttempts = 5
	deployRetryMax = 30 * time.Second
)

// deployRetryBase is the wait after the first transient failure; tests
// shorten it.
var deployRetryBase = 2 * time.Second

// deployRetryWait is the wait after the given number of failed attempts.
func deployRetryWait(failed int) time.Duration {
	return min(deployRetryBase<<(failed-1), deployRetryMax)
}

// queuedDeploy is a deploy trigger waiting for the deploy worker, with the
// attempts already failed transiently.
type queuedDeploy struct {
	t      protocol.Trigger
	failed int
}

// hubIntake is the default DeployIntake: it checks GitHub with a fetch
// token the hub issues for the trigger, before any run exists. The hub
// refuses that token for a trigger it no longer holds open; the checks then
// fail permanently and the trigger is rejected.
type hubIntake struct {
	base      trigger.Intake
	githubURL string // "" means trigger.DefaultGitHubURL
	http      *http.Client
	tokens    func(ctx context.Context, triggerID string) (string, error)
}

// Handle decides t with one token for all of its GitHub calls.
func (h *hubIntake) Handle(ctx context.Context, t protocol.Trigger) (trigger.Decision, error) {
	var token string
	refs := &trigger.GitHubRefChecker{BaseURL: h.githubURL, HTTP: h.http, Token: func(ctx context.Context, _ string) (string, error) {
		if token != "" {
			return token, nil
		}
		tok, err := h.tokens(ctx, t.TriggerId)
		if errors.Is(err, hubtokens.ErrRefused) {
			return "", trigger.Permanent(err)
		}
		if err != nil {
			return "", err
		}
		token = tok
		return tok, nil
	}}
	in := h.base
	in.Refs = refs
	in.LoadConfig = refs.LoadConfig
	return in.Handle(ctx, t)
}

// queueDeploy queues deploy trigger t for the deploy worker. HandleFrame
// must not wait for the intake: its GitHub checks wait for token frames
// that arrive through HandleFrame. A trigger already queued is ignored.
func (d *Daemon) queueDeploy(t protocol.Trigger) {
	d.mu.Lock()
	dup := d.deploying[t.TriggerId]
	if !dup {
		d.deploying[t.TriggerId] = true
		d.deployQ = append(d.deployQ, queuedDeploy{t: t})
	}
	d.mu.Unlock()
	if dup {
		d.log.Info("duplicate deploy trigger ignored", "trigger", t.TriggerId)
		return
	}
	d.wakeDeployWorker()
}

func (d *Daemon) wakeDeployWorker() {
	select {
	case d.deployWake <- struct{}{}:
	default:
	}
}

// deployWorker decides queued deploy triggers one at a time, so two
// deliveries of one push cannot both create its run. A trigger whose checks
// failed transiently waits for its next attempt off the worker, still
// marked queued, so triggers for other envs are decided meanwhile.
func (d *Daemon) deployWorker(ctx context.Context) {
	for {
		d.mu.Lock()
		if len(d.deployQ) == 0 {
			d.mu.Unlock()
			select {
			case <-ctx.Done():
				return
			case <-d.deployWake:
			}
			continue
		}
		q := d.deployQ[0]
		d.deployQ = d.deployQ[1:]
		d.mu.Unlock()
		if d.decideDeploy(ctx, q.t, q.failed) {
			q.failed++
			go d.requeueDeploy(ctx, q, deployRetryWait(q.failed))
			continue
		}
		d.mu.Lock()
		delete(d.deploying, q.t.TriggerId)
		d.mu.Unlock()
	}
}

// requeueDeploy queues q again after wait, unless ctx ends first.
func (d *Daemon) requeueDeploy(ctx context.Context, q queuedDeploy, wait time.Duration) {
	select {
	case <-ctx.Done():
		return
	case <-d.clk.After(wait):
	}
	d.mu.Lock()
	d.deployQ = append(d.deployQ, q)
	d.mu.Unlock()
	d.wakeDeployWorker()
}

// decideDeploy runs the intake of t, after failed earlier attempts that
// failed transiently, and answers the hub. A trigger already answered is
// skipped: the hub resends frames it has not seen acknowledged, and it
// refuses tokens for answered triggers. One cut short by shutdown gets no
// answer. The trigger frame was acknowledged when it was queued, so the hub
// does not send it again: a GitHub or store check that failed transiently
// is retried, and decideDeploy reports true without answering, until
// deployAttempts attempts have failed; then, or on a permanent failure such
// as the hub refusing the trigger's token, t is rejected with the last
// error. An accepted run is queued for the deploy lane only once its
// accepted frame is in the outbox, so the hub knows the run before any
// token request for it.
func (d *Daemon) decideDeploy(ctx context.Context, t protocol.Trigger, failed int) (retry bool) {
	answered, err := d.st.TriggerRecorded(ctx, t.TriggerId)
	if err != nil {
		d.log.Error("look up deploy trigger failed", "trigger", t.TriggerId, "err", err)
		return false
	}
	if answered {
		d.log.Info("duplicate deploy trigger ignored", "trigger", t.TriggerId)
		return false
	}
	dec, err := d.deploys.Handle(ctx, t)
	if ctx.Err() != nil {
		return false
	}
	if err != nil && !trigger.IsPermanent(err) && failed+1 < deployAttempts {
		d.log.Warn("deploy trigger check failed; retrying", "trigger", t.TriggerId, "attempt", failed+1, "err", err)
		return true
	}
	runID, reason := dec.RunID, ""
	switch {
	case err != nil:
		env := ""
		if t.Env != nil {
			env = *t.Env
		}
		runID, reason = "", fmt.Sprintf("deployments.%s: github check failed: %v", env, err)
	case !dec.Accepted:
		runID, reason = "", dec.Reason
	}
	if reason != "" {
		d.log.Warn("deploy trigger rejected", "trigger", t.TriggerId, "reason", reason)
	}
	if _, err := d.st.AnswerTrigger(ctx, t.TriggerId, runID, reason); err != nil {
		d.log.Error("record deploy answer failed", "trigger", t.TriggerId, "err", err)
		return false
	}
	d.client.Flush()
	if runID != "" {
		d.deploySched.Enqueue(ctx, runID, dec.Retry)
	}
	return false
}

// recoverDeploys settles the deploy runs an earlier agent left behind: it
// stops their leftover units and marks the ones still going Interrupted,
// then queues the Queued ones. An Interrupted run waits for `zeroci retry`.
func (d *Daemon) recoverDeploys(ctx context.Context) error {
	runner := d.o.DeployRunner
	if runner == nil {
		runner = execx.OS{}
	}
	rec := &deploy.Recoverer{
		Store: d.st, Runner: runner, Events: hubDeployEvents{client: d.client, log: d.log},
		Clock: d.clk.Now, Logger: d.log,
	}
	if _, err := rec.Recover(ctx); err != nil {
		return fmt.Errorf("daemon: %w", err)
	}
	if err := d.deploySched.Recover(ctx); err != nil {
		return fmt.Errorf("daemon: %w", err)
	}
	return nil
}
