package doctor

import (
	"context"
	"fmt"
)

// ForkTrust warns once per repository whose .zeroci.yml, as the last
// default-branch run on this host saw it, declares trust: all. It returns
// nothing when no repository does.
func ForkTrust(ctx context.Context, env Env) []Result {
	ins, err := installations(env)
	if err != nil || env.RepoConfigs == nil {
		return nil
	}
	var rs []Result
	for _, in := range ins {
		repos, err := env.RepoConfigs(ctx, in.dir)
		if err != nil {
			rs = append(rs, warn("fork trust", fmt.Sprintf("cannot read the repositories %s has run: %v", in.dir, err), "rerun as root: sudo zeroci doctor"))
			continue
		}
		for _, r := range repos {
			if r.Trust != "all" {
				continue
			}
			detail := fmt.Sprintf("repo %s: trust: all lets any fork PR run on this machine without approval", r.Repo)
			if r.HasDeployments {
				detail += " and is ignored by the hub because deployments are configured"
			}
			rs = append(rs, warn("fork trust", detail, "set checks.trust: collaborators in "+r.Repo+"'s .zeroci.yml unless every fork PR may run here"))
		}
	}
	for i := range rs {
		rs[i].ID = "fork_trust"
	}
	return rs
}
