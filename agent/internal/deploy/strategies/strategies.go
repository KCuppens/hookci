// Package strategies builds the deploy strategies the agent runs. It sits
// above deploy and its strategy packages, which cannot import each other.
package strategies

import (
	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/compose"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/health"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/script"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// Deps are what the strategies share.
type Deps struct {
	Store *store.Store
	// Proxy returns the adapter of a deployment's route block.
	Proxy    func(route config.DeploymentRoute) (proxy.ProxyAdapter, error)
	Health   *health.Checker
	Clock    clock.Clock
	StateDir string                           // agent state dir
	WorkDir  func(run store.DeployRun) string // checkout dir of the run's sha
	// Access lets the deploy unit read the compose overrides; nil leaves
	// them to the agent only.
	Access *compose.UnitAccess
	// Changes returns the change lister migrate.before diffs a run's SHA
	// with; nil makes migrate.before back up on every deploy.
	Changes func(run store.DeployRun) deploy.ChangeLister
}

// New returns every deploy strategy keyed by its name, for
// deploy.Engine.Strategies.
func New(d Deps) map[string]deploy.DeployStrategy {
	all := []deploy.DeployStrategy{
		&compose.BlueGreen{Store: d.Store, Proxy: d.Proxy, Health: d.Health, StateDir: d.StateDir, WorkDir: d.WorkDir, Access: d.Access, Changes: d.Changes},
		&compose.InPlace{Store: d.Store, Health: d.Health, StateDir: d.StateDir, WorkDir: d.WorkDir, Access: d.Access, Changes: d.Changes},
		&script.Script{WorkDir: d.WorkDir, Clock: d.Clock},
	}
	out := make(map[string]deploy.DeployStrategy, len(all))
	for _, s := range all {
		out[s.Name()] = s
	}
	return out
}
