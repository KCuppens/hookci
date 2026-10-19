package deploy

import "context"

// Strategy defines the interface for zero-downtime deployment execution (implemented in M2).
type Strategy interface {
	Deploy(ctx context.Context, runID string, env string) error
}
