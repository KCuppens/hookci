// Package deploy runs deployments. A DeployStrategy turns a deployment config
// into a plan of steps; the Engine runs the plan step by step, persisting each
// step before it runs so a retry can resume at the first unfinished step.
package deploy

import (
	"context"
	"io"
	"time"

	"github.com/KCuppens/hookci/agent/internal/clock"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// Phase says which run state a step runs in.
type Phase int

const (
	// PhaseApply steps run while the run is Running.
	PhaseApply Phase = iota
	// PhaseVerify steps run while the run is Verifying. The engine moves the
	// run to Verifying when the first PhaseVerify step starts.
	PhaseVerify
)

// Step is one step of a deploy plan. Run must be idempotent: a step left
// running by a crash runs again on resume.
type Step struct {
	Name  string // for example build, override, migrate, start, health, swap, verify, finalize
	Phase Phase
	Run   func(ctx context.Context, sc *StepContext) error
}

// StepContext is what a step and Rollback work with.
type StepContext struct {
	Run store.DeployRun
	Cfg config.Deployment
	// Outputs holds the outputs of the earlier steps. A step may set keys;
	// the engine persists them when the step finishes.
	Outputs map[string]string
	Exec    Executor
	Log     io.Writer // run log, redacted
	Clock   clock.Clock
	// Progress reports a sub-step inside the running step, such as a
	// `::hookci step <name>` marker of a script deploy. It emits a progress
	// event with step=name, the index of the running planned step and
	// steps_total. It may be nil.
	Progress func(name string)
}

// DeployStrategy is a compiled-in way to deploy.
type DeployStrategy interface {
	Name() string
	// Plan returns the steps of run. The same run and config must give the
	// same steps, so a resumed run lines up with its persisted steps.
	Plan(run store.DeployRun, cfg config.Deployment) ([]Step, error)
	// Rollback undoes the steps before failedIndex and whatever the failed
	// step left behind.
	Rollback(ctx context.Context, sc *StepContext, failedIndex int) error
}

// ExecOpts configures one Executor command.
type ExecOpts struct {
	Dir            string
	Env            map[string]string
	Timeout        time.Duration
	Stdout, Stderr io.Writer
}

// Executor runs deploy commands. name labels the command in logs.
type Executor interface {
	Run(ctx context.Context, name string, argv []string, opts ExecOpts) error
}
