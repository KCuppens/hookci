package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/trigger"
	"github.com/KCuppens/zerocideploy/agent/internal/hubclient"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// newDeployScheduler builds the deploy lane: the engine that runs one
// deploy and the scheduler that orders deploys per env.
func newDeployScheduler(st *store.Store, o Options, events deploy.EventSink, load func(context.Context, store.DeployRun) (config.Deployment, error)) *deploy.Scheduler {
	eng := &deploy.Engine{Store: st, Strategies: deployStrategies(), Events: events, Clock: o.Clock, LoadDeployment: load}
	return &deploy.Scheduler{Store: st, Engine: eng, Events: events, Clock: o.Clock.Now, Logger: o.Logger, LoadDeployment: load}
}

// deployStrategies returns the strategies this agent runs, keyed by their
// deployments.<env>.strategy name.
func deployStrategies() map[string]deploy.DeployStrategy {
	return map[string]deploy.DeployStrategy{}
}

// githubDeployment returns a loader of a run's deployments.<env> block from
// the .zeroci.yml at the run's sha, fetched from GitHub with a token the hub
// issues for the run.
func githubDeployment(githubURL string, hc *http.Client, tokens func(ctx context.Context, runID string) (string, error)) func(context.Context, store.DeployRun) (config.Deployment, error) {
	return func(ctx context.Context, run store.DeployRun) (config.Deployment, error) {
		refs := &trigger.GitHubRefChecker{BaseURL: githubURL, HTTP: hc, Token: func(ctx context.Context, _ string) (string, error) {
			return tokens(ctx, run.RunID)
		}}
		cfg, err := refs.LoadConfig(ctx, run.Repo, run.SHA)
		if err != nil {
			return config.Deployment{}, fmt.Errorf("daemon: %w", err)
		}
		dep, ok := cfg.Deployments[run.Env]
		if !ok {
			return config.Deployment{}, fmt.Errorf("daemon: .zeroci.yml at %s has no deployments.%s", run.SHA, run.Env)
		}
		return dep, nil
	}
}

// hubDeployEvents sends deploy frames through the hub client's outbox. A
// frame that cannot be stored is logged; the deploy goes on.
type hubDeployEvents struct {
	client *hubclient.Client
	log    *slog.Logger
}

func (h hubDeployEvents) DeployPlanned(p protocol.JobPlanned) {
	if _, err := h.client.Send(context.Background(), p); err != nil {
		h.log.Error("send deploy plan failed", "run", p.RunId, "err", err)
	}
}

func (h hubDeployEvents) DeployEvent(ev protocol.Event) {
	if _, err := h.client.Send(context.Background(), ev); err != nil {
		h.log.Error("send deploy event failed", "run", ev.RunId, "err", err)
	}
}
