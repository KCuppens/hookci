package deploy

import (
	"encoding/json"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

// RouteDirs is deploy.route_dirs of cfg, the directories a route.file may be
// in, with the schema default when the deploy section is absent.
func RouteDirs(cfg config.AgentConfig) []string {
	d := cfg.Deploy
	if d == nil {
		d = &config.AgentConfigDeploy{}
		_ = json.Unmarshal([]byte("{}"), d)
	}
	return d.RouteDirs
}
