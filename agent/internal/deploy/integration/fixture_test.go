// Package integration holds the end-to-end deploy suite against real docker
// and caddy (build tag integration) and the check that keeps its fixture,
// examples/compose-app, a valid config on every go test.
package integration

import (
	"path/filepath"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/config"
)

// fixtureDir is examples/compose-app, relative to this package.
const fixtureDir = "../../../../examples/compose-app"

func TestFixture_ConfigValid(t *testing.T) {
	path := filepath.Join(fixtureDir, ".hookci.yml")
	cfg, diags, err := config.Load(path, config.ParseOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if diags.HasErrors() {
		t.Fatalf("fixture config has errors:\n%s", diags.Format(path))
	}
	if errs := config.ValidateDeployments(&cfg.HookCIConfig); len(errs) != 0 {
		t.Fatalf("ValidateDeployments: %v", errs)
	}
	d, ok := cfg.Deployments["staging"]
	if !ok {
		t.Fatal("fixture has no deployments.staging")
	}
	if d.Strategy != "compose-bluegreen" || d.Route == nil || d.Route.Kind != config.DeploymentRouteKindCaddy {
		t.Fatalf("deployments.staging: strategy %q route %+v, want compose-bluegreen behind caddy", d.Strategy, d.Route)
	}
}
