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

// inplaceOverride is the file name of the compose-inplace override, written
// into the run's checkout next to the user's files.
const inplaceOverride = ".zeroci-inplace.override.yml"

// InPlace is the compose-inplace strategy: it rebuilds the image and
// recreates the one compose project of the deployment on it, with brief
// downtime, then gates on health. It has no rollback.
type InPlace struct {
	Health  *health.Checker
	WorkDir func(run store.DeployRun) string // checkout dir of the run's sha
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
	in := OverrideInput{Env: sc.Run.Env, ComposeFile: file, Service: sc.Cfg.Compose.Service, Image: image}
	if sc.Cfg.Compose.SharedNetwork != nil {
		in.SharedNetwork = *sc.Cfg.Compose.SharedNetwork
	}
	override, err := RenderOverride(in)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(workdir, inplaceOverride)
	if err := writeFileAtomic(path, override); err != nil {
		return nil, fmt.Errorf("compose: writing override: %w", err)
	}
	return []string{"docker", "compose", "-p", project, "-f", file, "-f", path}, nil
}

func (p *InPlace) execOpts(sc *deploy.StepContext) deploy.ExecOpts {
	return deploy.ExecOpts{Dir: p.WorkDir(sc.Run), Stdout: sc.Log, Stderr: sc.Log}
}
