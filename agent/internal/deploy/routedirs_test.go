package deploy

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

func TestRouteDirs(t *testing.T) {
	if got := RouteDirs(config.AgentConfig{}); !slices.Equal(got, []string{"/etc/caddy"}) {
		t.Errorf("default = %q, want [/etc/caddy]", got)
	}
	var cfg config.AgentConfig
	if err := json.Unmarshal([]byte(`{"deploy":{}}`), &cfg); err != nil {
		t.Fatal(err)
	}
	if got := RouteDirs(cfg); !slices.Equal(got, []string{"/etc/caddy"}) {
		t.Errorf("empty deploy section = %q, want [/etc/caddy]", got)
	}
	if err := json.Unmarshal([]byte(`{"deploy":{"route_dirs":["/opt/infra/routes","/etc/caddy"]}}`), &cfg); err != nil {
		t.Fatal(err)
	}
	if got := RouteDirs(cfg); !slices.Equal(got, []string{"/opt/infra/routes", "/etc/caddy"}) {
		t.Errorf("set = %q", got)
	}
}
