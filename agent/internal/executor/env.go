package executor

import (
	"os"
	"slices"

	"github.com/KCuppens/hookci/agent/internal/store"
)

// EnvInput is everything a job environment is built from.
type EnvInput struct {
	Run         store.Run
	Job         string
	Dir         RunDir
	ProxyEnv    []string // netns.ProxyEnv or Network.Env(); nil without a proxy
	ServiceEnv  []string // Postgres.Env(); nil without services
	InheritPATH bool     // isolation "none": keep the agent's PATH so local toolchains resolve
}

// BuildJobEnv returns the whole environment of a job, sorted. Backends add
// nothing, so a job never sees the agent's own environment: no env_file
// values, DOCKER_HOST, SSH_AUTH_SOCK, HOOKCI_STATE_DIR or tokens.
func BuildJobEnv(in EnvInput) []string {
	path := JobPATH
	if in.InheritPATH {
		if p := os.Getenv("PATH"); p != "" {
			path = p
		}
	}
	env := []string{
		"PATH=" + path,
		"HOME=" + in.Dir.Home(),
		"TMPDIR=" + in.Dir.Tmp(),
		"LANG=C.UTF-8",
		"CI=true",
	}
	// Both families are exported so scripts written for ZeroCI keep working.
	for _, prefix := range []string{"HOOKCI", "ZEROCI"} {
		env = append(env,
			prefix+"=1",
			prefix+"_RUN_ID="+in.Run.ID,
			prefix+"_JOB="+in.Job,
			prefix+"_SHA="+in.Run.SHA,
			prefix+"_REF="+in.Run.Ref,
			prefix+"_EVENT="+in.Run.Event,
		)
		if in.Run.PR != nil {
			env = append(env, prefix+"_BASE_SHA="+in.Run.BaseSHA)
		}
	}
	env = append(env, in.ProxyEnv...)
	env = append(env, in.ServiceEnv...)
	slices.Sort(env)
	return env
}
