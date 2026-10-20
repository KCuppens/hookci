package strategies

import (
	"slices"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

// TestNew_CoversSchemaStrategies checks that every strategy the config schema
// accepts has an implementation, so no valid config fails at plan time.
func TestNew_CoversSchemaStrategies(t *testing.T) {
	got := New(Deps{})
	var names []string
	for name := range got {
		names = append(names, name)
	}
	slices.Sort(names)
	want := []string{
		string(config.DeploymentStrategyComposeBluegreen),
		string(config.DeploymentStrategyComposeInplace),
		string(config.DeploymentStrategyScript),
	}
	if !slices.Equal(names, want) {
		t.Errorf("strategies = %v, want %v", names, want)
	}
}
