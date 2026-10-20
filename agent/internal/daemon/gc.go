package daemon

import (
	"context"
	"fmt"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/gc"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// newCollector returns the agent's GC of deploy images, build cache and run
// dirs. It manages the envs recorded by recordGCTargets and runs docker
// through o.DeployRunner as the agent's own user.
func newCollector(st *store.Store, o Options, cfg config.AgentConfig) *gc.Collector {
	runner := o.DeployRunner
	if runner == nil {
		runner = execx.OS{}
	}
	return &gc.Collector{
		Runner:   runner,
		Store:    st,
		StateDir: o.StateDir,
		Cfg:      cfg,
		Clock:    o.Clock,
		Log:      o.Logger,
		Repos: func(ctx context.Context) ([]gc.RepoEnv, error) {
			targets, err := st.ListGCTargets(ctx)
			if err != nil {
				return nil, fmt.Errorf("daemon: %w", err)
			}
			envs := make([]gc.RepoEnv, len(targets))
			for i, t := range targets {
				envs[i] = gc.RepoEnv{Repo: t.Repo, Env: t.Env, Project: t.Project, Retain: t.RetainImages}
			}
			return envs, nil
		},
	}
}

// recordGCTargets wraps a deploy config loader so every env loaded with a
// compose project becomes a GC target with its retain.images. A failure to
// record is logged; the deploy still gets its config.
func recordGCTargets(st *store.Store, o Options, load func(context.Context, store.DeployRun) (config.Deployment, error)) func(context.Context, store.DeployRun) (config.Deployment, error) {
	return func(ctx context.Context, run store.DeployRun) (config.Deployment, error) {
		dep, err := load(ctx, run)
		if err != nil || dep.Compose == nil || dep.Compose.Project == "" {
			return dep, err
		}
		retain := 0
		if dep.Retain != nil {
			retain = dep.Retain.Images
		}
		t := store.GCTarget{Repo: run.Repo, Env: run.Env, Project: dep.Compose.Project, RetainImages: retain}
		if err := st.SetGCTarget(ctx, t); err != nil {
			o.Logger.Warn("gc: record deploy env", "repo", run.Repo, "env", run.Env, "err", err)
		}
		return dep, nil
	}
}
