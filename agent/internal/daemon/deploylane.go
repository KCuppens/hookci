package daemon

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"syscall"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/compose"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/health"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/strategies"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/trigger"
	"github.com/KCuppens/zerocideploy/agent/internal/executor"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/hubclient"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy/caddy"
	"github.com/KCuppens/zerocideploy/agent/internal/redact"
	"github.com/KCuppens/zerocideploy/agent/internal/source"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// newDeployScheduler builds the deploy lane: the engine that runs one
// deploy and the scheduler that orders deploys per env. Each run is checked
// out into deployWorkDir and runs in deploy units as deploy.DeployUser.
func (d *Daemon) newDeployScheduler(credential string, events deploy.EventSink, load func(context.Context, store.DeployRun) (config.Deployment, error)) *deploy.Scheduler {
	o := d.o
	runner := o.DeployRunner
	if runner == nil {
		runner = execx.OS{}
	}
	eng := &deploy.Engine{
		Store: d.st,
		Strategies: strategies.New(strategies.Deps{
			Store:    d.st,
			Proxy:    func(route config.DeploymentRoute) (proxy.ProxyAdapter, error) { return routeProxy(runner, route) },
			Health:   &health.Checker{Client: o.HealthClient, Clock: o.Clock},
			Clock:    o.Clock,
			StateDir: o.StateDir,
			WorkDir:  d.deployWorkDir,
			Access:   &compose.UnitAccess{Cred: d.deployCred},
		}),
		Events:         events,
		Clock:          o.Clock,
		LoadDeployment: load,
		NewExecutor: func(ctx context.Context, run store.DeployRun, cfg config.Deployment) (deploy.Executor, error) {
			trusted, err := d.st.DeployRunAccepted(ctx, run.RunID)
			if err != nil {
				return nil, fmt.Errorf("daemon: %w", err)
			}
			red, _ := redact.New([]string{credential}, nil)
			return deploy.NewExecutorForRun(run, trusted, cfg, deploy.ExecutorDeps{Runner: runner, Redactor: red})
		},
		Checkout: d.checkoutDeploy,
	}
	return &deploy.Scheduler{Store: d.st, Engine: eng, Events: events, Clock: o.Clock.Now, Logger: o.Logger, LoadDeployment: load}
}

// routeProxy returns the adapter of a deployments.<env>.route block.
func routeProxy(runner execx.Runner, route config.DeploymentRoute) (proxy.ProxyAdapter, error) {
	if route.Kind != config.DeploymentRouteKindCaddy {
		return nil, fmt.Errorf("daemon: route kind %q is not supported; use caddy", route.Kind)
	}
	a, err := caddy.New(runner, route.Reload)
	if err != nil {
		return nil, fmt.Errorf("daemon: %w", err)
	}
	return a, nil
}

// deployWorkDir is the checkout of a deploy run, <StateDir>/deploy-work/<run_id>.
func (d *Daemon) deployWorkDir(run store.DeployRun) string {
	return filepath.Join(d.o.StateDir, "deploy-work", run.RunID)
}

// deployCred is the account deploy units run as.
func (d *Daemon) deployCred() (*syscall.Credential, error) {
	return isolation.LookupCredential(cmp.Or(d.o.DeployUser, deploy.DeployUser))
}

// checkoutDeploy fetches run's repo at its sha into deployWorkDir, owned by
// the deploy user, with a token the hub issues for the run. A finished
// checkout from an earlier pass is reused. The fetch goes to
// <dir>.partial first, so a pass cut short leaves no half tree at dir.
func (d *Daemon) checkoutDeploy(ctx context.Context, run store.DeployRun) error {
	dir := d.deployWorkDir(run)
	if _, err := os.Stat(dir); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("daemon: deploy checkout: %w", err)
	}
	cred, err := d.deployCred()
	if err != nil {
		return fmt.Errorf("daemon: deploy checkout: %w", err)
	}
	root := filepath.Dir(dir)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("daemon: deploy checkout: %w", err)
	}
	if err := executor.OpenTo(d.o.StateDir, cred, root); err != nil {
		return fmt.Errorf("daemon: deploy checkout: hand %s to the deploy user: %w", root, err)
	}
	partial := dir + ".partial"
	if err := os.RemoveAll(partial); err != nil {
		return fmt.Errorf("daemon: deploy checkout: %w", err)
	}
	co, err := d.src.Checkout(ctx, source.Request{Repo: run.Repo, SHA: run.SHA, Ref: run.Ref, RunID: run.RunID, RunAs: cred}, partial)
	if err != nil {
		_ = os.RemoveAll(partial)
		return fmt.Errorf("daemon: deploy checkout: %w", err)
	}
	co.Release()
	if err := os.Rename(partial, dir); err != nil {
		return fmt.Errorf("daemon: deploy checkout: %w", err)
	}
	return nil
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
