package scheduler

import (
	"strconv"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

const kindDeploy = "deploy"

// SupersedeKey groups runs that replace each other: checks on a PR
// (pr:<repo>:<pr>), checks on a push or local run (push:<repo>:<ref>) and
// deploys (deploy:<repo>:<env>).
func SupersedeKey(run store.Run) string {
	switch {
	case run.Kind == kindDeploy:
		return "deploy:" + run.Repo + ":" + run.Env
	case run.PR != nil:
		return "pr:" + run.Repo + ":" + strconv.Itoa(*run.PR)
	default:
		return "push:" + run.Repo + ":" + run.Ref
	}
}

// shortSHA is the 7-character SHA used in reasons.
func shortSHA(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}
