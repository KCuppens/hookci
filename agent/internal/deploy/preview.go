package deploy

import (
	"context"
	"errors"
	"fmt"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// ErrNoPreview reports a strategy that cannot show a dry run.
var ErrNoPreview = errors.New("strategy has no dry-run preview")

// PlanPreview is what a deploy would do, computed without doing any of it.
// Fields a strategy does not use stay empty.
type PlanPreview struct {
	Repo     string   `json:"repo"`
	Env      string   `json:"env"`
	Strategy string   `json:"strategy"`
	Steps    []string `json:"steps"`
	// ActiveColor is the color serving now, "" when nothing does.
	ActiveColor string `json:"active_color,omitempty"`
	TargetColor string `json:"target_color,omitempty"`
	TargetPort  int    `json:"target_port,omitempty"`
	Image       string `json:"image,omitempty"`
	// Override is the compose override the deploy would write.
	Override string `json:"override,omitempty"`
	// RouteDiff is a unified diff from the current route file to the route
	// the deploy would write; "" when they are equal.
	RouteDiff string `json:"route_diff,omitempty"`
}

// Previewer is a strategy that can show a dry run. Preview must not run
// commands, write files or reserve ports.
type Previewer interface {
	Preview(ctx context.Context, pc PreviewContext) (PlanPreview, error)
}

// PreviewStore is the read-only part of the store a preview needs.
type PreviewStore interface {
	GetDeployState(ctx context.Context, repo, env string) (store.DeployState, bool, error)
	GetPortAllocation(ctx context.Context, repo, env, color string) (int, error)
	NextFreePort(ctx context.Context) (int, error)
}

// PreviewContext is the deploy a preview describes. ReadFile reads the
// marker and route files, so a test can see every read.
type PreviewContext struct {
	Repo, Env, SHA string
	Cfg            config.Deployment
	Store          PreviewStore
	ReadFile       func(path string) ([]byte, error)
}

// BuildPreview previews pc with the strategy of pc.Cfg, or returns an error
// wrapping ErrNoPreview when that strategy is not a Previewer.
func BuildPreview(ctx context.Context, e *Engine, pc PreviewContext) (PlanPreview, error) {
	name := string(pc.Cfg.Strategy)
	s, ok := e.Strategies[name]
	if !ok {
		return PlanPreview{}, fmt.Errorf("deploy: preview %s: unknown strategy %q", pc.Env, name)
	}
	p, ok := s.(Previewer)
	if !ok {
		return PlanPreview{}, fmt.Errorf("deploy: preview %s: %s: %w", pc.Env, name, ErrNoPreview)
	}
	pv, err := p.Preview(ctx, pc)
	if err != nil {
		return PlanPreview{}, err
	}
	pv.Repo, pv.Env, pv.Strategy = pc.Repo, pc.Env, name
	return pv, nil
}

// StepNames returns the names of steps, in order.
func StepNames(steps []Step) []string {
	names := make([]string, len(steps))
	for i, s := range steps {
		names[i] = s.Name
	}
	return names
}
