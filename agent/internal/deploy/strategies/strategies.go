// Package strategies builds the deploy strategies the agent runs. It sits
// above deploy and its strategy packages, which cannot import each other.
package strategies

import (
	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/compose"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/health"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/script"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// Deps are what the strategies share.
type Deps struct {
	Store    *store.Store
	Proxy    proxy.ProxyAdapter
	Health   *health.Checker
	Clock    clock.Clock
	StateDir string                           // agent state dir
	WorkDir  func(run store.DeployRun) string // checkout dir of the run's sha
}

// New returns every deploy strategy keyed by its name, for
// deploy.Engine.Strategies.
func New(d Deps) map[string]deploy.DeployStrategy {
	all := []deploy.DeployStrategy{
		&compose.BlueGreen{Store: d.Store, Proxy: d.Proxy, Health: d.Health, StateDir: d.StateDir, WorkDir: d.WorkDir},
		&compose.InPlace{Health: d.Health, WorkDir: d.WorkDir},
		&script.Script{WorkDir: d.WorkDir, Clock: d.Clock},
	}
	out := make(map[string]deploy.DeployStrategy, len(all))
	for _, s := range all {
		out[s.Name()] = s
	}
	return out
}
