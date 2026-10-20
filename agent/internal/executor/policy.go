package executor

import "errors"

// kindDeploy is the store.Run.Kind of a deploy run.
const kindDeploy = "deploy"

// ErrDeployNotAllowed is wrapped by RunSetup for a deploy run whose policy
// does not allow deploys and secrets.
var ErrDeployNotAllowed = errors.New("run policy does not allow deploy")

// RunPolicy is what one run may do. The daemon derives it from the run's
// trust; the zero value allows nothing and leaves the network to the run's
// trust domain.
type RunPolicy struct {
	// AllowSecrets lets the run use secrets. Check jobs never get any
	// (BuildJobEnv gives them no env_file value and none of the agent's
	// environment); a deploy run, which needs its deployment's env_file, is
	// set up only with AllowSecrets.
	AllowSecrets bool
	// AllowDeploy lets a deploy run be set up at all.
	AllowDeploy bool
	// EgressProxyOnly sends all of the run's egress through its egress
	// proxy and refuses direct egress; see startNetwork.
	EgressProxyOnly bool
}

// allowsDeploy reports whether p may set up a deploy run.
func (p RunPolicy) allowsDeploy() bool {
	return p.AllowDeploy && p.AllowSecrets
}
