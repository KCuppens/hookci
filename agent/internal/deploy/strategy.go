// Package deploy holds the compiled-in DeployStrategy interface (plan §7).
// M0 fixes the package layout only; the strategies are implemented in M2.
package deploy

import (
	"context"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

// Step is one persisted step of a deploy plan (M2 fills in the fields it needs).
type Step struct {
	Index int
	Name  string
}

// Strategy is the compiled-in DeployStrategy interface (§7). Plan turns a
// deployment config into persisted steps, Run resumes from a step index after
// a crash, and Verify and Rollback act on the deployed release. Implemented
// in M2.
type Strategy interface {
	Name() string
	Plan(cfg config.Deployment) ([]Step, error)
	Run(ctx context.Context, fromStep int) error
	Verify(ctx context.Context) error
	Rollback(ctx context.Context) error
}
