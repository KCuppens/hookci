package daemon

import (
	"context"

	"github.com/KCuppens/hookci/agent/internal/executor"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// kindDeploy is the store.Run.Kind of a deploy run.
const kindDeploy = "deploy"

// hubModeSelfHosted is the /v1/info mode of a self-hosted hub.
const hubModeSelfHosted = "self_hosted"

// refreshHubMode re-reads the hub's mode, which decides whether a
// .hookci.yml may declare trust: all. On failure the mode agent.json stored
// at connect stays.
func (d *Daemon) refreshHubMode(ctx context.Context) {
	info, err := d.o.HubInfo(ctx)
	if err != nil {
		d.log.Warn("hub mode refresh failed; keeping the stored mode", "self_hosted", d.selfHosted.Load(), "err", err)
		return
	}
	d.selfHosted.Store(info.Mode == hubModeSelfHosted)
}

// Step and reason of a deploy job an untrusted run skips.
const (
	stepUntrusted         = "untrusted"
	reasonUntrustedDeploy = "untrusted run cannot deploy"
)

// optionsForTrust is the policy of a run the hub sent with trust. Only a
// trusted run gets secrets and deploys with direct egress; anything else,
// an unknown value included, is held to the untrusted policy.
func optionsForTrust(trust protocol.TriggerTrust) executor.RunPolicy {
	if trust == protocol.TriggerTrustTrusted {
		return executor.RunPolicy{AllowSecrets: true, AllowDeploy: true, EgressProxyOnly: false}
	}
	return executor.RunPolicy{AllowSecrets: false, AllowDeploy: false, EgressProxyOnly: true}
}

// skipUntrustedDeploy reports every queued job of the deploy run runID
// skipped with step "untrusted" and cancels the run, which is never
// submitted.
func (d *Daemon) skipUntrustedDeploy(ctx context.Context, runID string) {
	jobs, err := d.st.Jobs(ctx, runID)
	if err != nil {
		d.log.Error("list deploy jobs failed", "run", runID, "err", err)
	}
	for _, j := range jobs {
		if j.State != store.JobQueued {
			continue
		}
		u := store.JobUpdate{Step: stepUntrusted, Reason: reasonUntrustedDeploy}
		if err := d.st.TransitionJob(ctx, runID, j.Name, []store.JobState{store.JobQueued}, store.JobSkipped, u); err != nil {
			d.log.Error("skip deploy job failed", "run", runID, "job", j.Name, "err", err)
		}
	}
	if err := d.st.Transition(ctx, runID, []store.RunState{store.RunQueued}, store.RunCancelled, reasonUntrustedDeploy); err != nil {
		d.log.Error("cancel untrusted deploy failed", "run", runID, "err", err)
	}
}
