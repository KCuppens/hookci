package compose

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/health"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// InPlace is the compose-inplace strategy: it rebuilds the image and
// recreates the one compose project of the deployment on it, with brief
// downtime, then gates on health. It has no rollback.
type InPlace struct {
	Health   *health.Checker
	StateDir string                           // agent state dir; the override is <StateDir>/deploy/<repo>/<env>/inplace.override.yml
	WorkDir  func(run store.DeployRun) string // checkout dir of the run's sha
	Access   *UnitAccess                      // nil leaves the override to the agent only
}

// Name returns the strategy name of deployments.<env>.strategy.
func (p *InPlace) Name() string { return "compose-inplace" }

// Plan returns build, migrate (only when migrate.run is set), up and health.
func (p *InPlace) Plan(run store.DeployRun, cfg config.Deployment) ([]deploy.Step, error) {
	if cfg.Compose == nil {
		return nil, fmt.Errorf("deployments.%s.compose: required for compose-inplace; add compose.project and compose.service", run.Env)
	}
	if cfg.Health == nil {
		return nil, fmt.Errorf("deployments.%s.health: required for compose-inplace; add health.url with {port}", run.Env)
	}
	if _, err := ImageTag(cfg.Compose.Project, run.SHA); err != nil {
		return nil, fmt.Errorf("deployments.%s.%w", run.Env, err)
	}
	steps := []deploy.Step{{Name: "build", Phase: deploy.PhaseApply, Run: p.build}}
	if cfg.Migrate != nil && cfg.Migrate.Run != "" {
		steps = append(steps, deploy.Step{Name: "migrate", Phase: deploy.PhaseApply, Run: p.migrate})
	}
	return append(steps,
		deploy.Step{Name: "up", Phase: deploy.PhaseApply, Run: p.up},
		deploy.Step{Name: "health", Phase: deploy.PhaseVerify, Run: p.health},
	), nil
}

// Preview shows the steps of a deploy of pc.SHA, its image and the override
// pinning that image. It runs and writes nothing.
func (p *InPlace) Preview(_ context.Context, pc deploy.PreviewContext) (deploy.PlanPreview, error) {
	run, cfg := store.DeployRun{Repo: pc.Repo, Env: pc.Env, SHA: pc.SHA}, pc.Cfg
	steps, err := p.Plan(run, cfg)
	if err != nil {
		return deploy.PlanPreview{}, err
	}
	image, err := ImageTag(cfg.Compose.Project, run.SHA)
	if err != nil {
		return deploy.PlanPreview{}, err
	}
	override, err := renderOverride(run.Env, p.WorkDir(run), cfg, image, "", 0)
	if err != nil {
		return deploy.PlanPreview{}, err
	}
	return deploy.PlanPreview{Steps: deploy.StepNames(steps), Image: image, Override: string(override)}, nil
}

// build builds <project>:<sha7> with BuildKit unless the image exists.
func (p *InPlace) build(ctx context.Context, sc *deploy.StepContext) error {
	return buildImage(ctx, sc, p.WorkDir(sc.Run))
}

// migrate runs migrate.run in the new image.
func (p *InPlace) migrate(ctx context.Context, sc *deploy.StepContext) error {
	argv, err := p.composeArgv(sc)
	if err != nil {
		return err
	}
	argv = append(argv, "run", "--rm", sc.Cfg.Compose.Service, "sh", "-c", sc.Cfg.Migrate.Run)
	return sc.Exec.Run(ctx, "migrate", argv, p.execOpts(sc))
}

// up recreates the project on the new image.
func (p *InPlace) up(ctx context.Context, sc *deploy.StepContext) error {
	argv, err := p.composeArgv(sc)
	if err != nil {
		return err
	}
	return sc.Exec.Run(ctx, "up", append(argv, "up", "-d", "--remove-orphans"), p.execOpts(sc))
}

// health waits until the service answers its health URL, with {port} being
// the host port the user's compose file publishes.
func (p *InPlace) health(ctx context.Context, sc *deploy.StepContext) error {
	port := 0
	if strings.Contains(sc.Cfg.Health.Url, "{port}") {
		var err error
		if port, err = PublishedPort(sc.Run.Env, composeFile(p.WorkDir(sc.Run), sc.Cfg), sc.Cfg.Compose.Service); err != nil {
			return err
		}
	}
	spec, err := healthSpecFor(sc, port)
	if err != nil {
		return err
	}
	return p.Health.Wait(ctx, spec)
}

// Rollback does nothing: the old containers are gone once up ran, and
// before it nothing serving changed.
func (p *InPlace) Rollback(_ context.Context, sc *deploy.StepContext, _ int) error {
	fmt.Fprintln(sc.Log, "compose-inplace has no rollback")
	return nil
}

// composeArgv writes the override pinning the image and returns
// "docker compose -p <project> -f <file> -f <override>".
func (p *InPlace) composeArgv(sc *deploy.StepContext) ([]string, error) {
	project := sc.Cfg.Compose.Project
	image, err := ImageTag(project, sc.Run.SHA)
	if err != nil {
		return nil, err
	}
	workdir := p.WorkDir(sc.Run)
	file := composeFile(workdir, sc.Cfg)
	override, err := renderOverride(sc.Run.Env, workdir, sc.Cfg, image, "", 0)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(envDir(p.StateDir, sc.Run), "inplace.override.yml")
	if err := p.Access.writeOverride(p.StateDir, path, override); err != nil {
		return nil, err
	}
	return []string{"docker", "compose", "-p", project, "-f", file, "-f", path}, nil
}

func (p *InPlace) execOpts(sc *deploy.StepContext) deploy.ExecOpts {
	return deploy.ExecOpts{Dir: p.WorkDir(sc.Run), Stdout: sc.Log, Stderr: sc.Log}
}
