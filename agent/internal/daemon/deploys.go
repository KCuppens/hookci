package daemon

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/deploy/trigger"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
)

// DeployIntake decides deploy triggers, the triggers that name an env.
type DeployIntake interface {
	Handle(ctx context.Context, t protocol.Trigger) (trigger.Decision, error)
}

// githubTimeout bounds each GitHub call a deploy check makes.
const githubTimeout = 30 * time.Second

// hubIntake is the default DeployIntake: it checks GitHub with a fetch
// token the hub issues for the trigger, before any run exists. The hub
// refuses that token for a trigger it no longer holds open; the checks then
// fail and the trigger is rejected.
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
		d.deployQ = append(d.deployQ, t)
	}
	d.mu.Unlock()
	if dup {
		d.log.Info("duplicate deploy trigger ignored", "trigger", t.TriggerId)
		return
	}
	select {
	case d.deployWake <- struct{}{}:
	default:
	}
}

// deployWorker decides queued deploy triggers one at a time, so two
// deliveries of one push cannot both create its run.
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
		t := d.deployQ[0]
		d.deployQ = d.deployQ[1:]
		d.mu.Unlock()
		d.decideDeploy(ctx, t)
		d.mu.Lock()
		delete(d.deploying, t.TriggerId)
		d.mu.Unlock()
	}
}

// decideDeploy runs the intake of t and answers the hub. A trigger already
// answered is skipped: the hub resends frames it has not seen acknowledged,
// and it refuses tokens for answered triggers. One cut short by shutdown
// gets no answer; the hub redelivers it.
func (d *Daemon) decideDeploy(ctx context.Context, t protocol.Trigger) {
	answered, err := d.st.TriggerRecorded(ctx, t.TriggerId)
	if err != nil {
		d.log.Error("look up deploy trigger failed", "trigger", t.TriggerId, "err", err)
		return
	}
	if answered {
		d.log.Info("duplicate deploy trigger ignored", "trigger", t.TriggerId)
		return
	}
	dec, err := d.deploys.Handle(ctx, t)
	if ctx.Err() != nil {
		return
	}
	runID, reason := dec.RunID, ""
	switch {
	case err != nil:
		env := ""
		if t.Env != nil {
			env = *t.Env
		}
		runID, reason = "", fmt.Sprintf("deployments.%s: github check failed: %v; the hub may redeliver", env, err)
	case !dec.Accepted:
		runID, reason = "", dec.Reason
	}
	if reason != "" {
		d.log.Warn("deploy trigger rejected", "trigger", t.TriggerId, "reason", reason)
	}
	if _, err := d.st.AnswerTrigger(ctx, t.TriggerId, runID, reason); err != nil {
		d.log.Error("record deploy answer failed", "trigger", t.TriggerId, "err", err)
		return
	}
	d.client.Flush()
}
