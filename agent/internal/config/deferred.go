package config

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/KCuppens/hookci/agent/internal/store"
)

const deferredPrefix = "setup-"

var deferredName = regexp.MustCompile(`^setup-[1-9][0-9]*$`)

// DeferredStep is a setup step with for: it runs as its own job after the
// plain setup steps, and only the jobs in For wait for it.
type DeferredStep struct {
	Name string // setup-1, setup-2, ... in step order
	Step SetupStep
}

// DeferredName is the job name of the nth (1-based) setup step with for.
func DeferredName(n int) string { return deferredPrefix + strconv.Itoa(n) }

// DeferredSteps lists the setup steps with for, named in step order.
func DeferredSteps(setup []SetupStep) []DeferredStep {
	var out []DeferredStep
	for _, s := range setup {
		if len(s.For) > 0 {
			out = append(out, DeferredStep{Name: DeferredName(len(out) + 1), Step: s})
		}
	}
	return out
}

// PlainSetupSteps are the setup steps without for, which every job waits for.
func PlainSetupSteps(setup []SetupStep) []SetupStep {
	var out []SetupStep
	for _, s := range setup {
		if len(s.For) == 0 {
			out = append(out, s)
		}
	}
	return out
}

// IsDeferredName reports whether name is a deferred setup job's name.
func IsDeferredName(name string) bool { return deferredName.MatchString(name) }

// checkSetupFor rejects for entries that name no job.
func checkSetupFor(c *Checks, li lineIndex) Diagnostics {
	var diags Diagnostics
	names := sortedKeys(c.Jobs)
	for i, s := range c.Setup {
		for j, job := range s.For {
			if _, ok := c.Jobs[job]; !ok {
				diags = append(diags, li.errorf(joinIndex(fmt.Sprintf("checks.setup[%d].for", i), j),
					"known jobs: "+strings.Join(names, ", "), "unknown job %s", quote(job)))
			}
		}
	}
	return diags
}

// PlanJobs plans checks' jobs behind the setup job: the setup job first, then
// one job per deferred setup step (needing setup), then the jobs. A job a step
// lists in for also needs that step's job; every other job without needs waits
// for setup alone.
func PlanJobs(checks *ResolvedChecks) []store.Job {
	deferred := DeferredSteps(checks.Setup)
	jobs := make([]store.Job, 0, len(checks.Jobs))
	for _, j := range checks.Jobs {
		needs := slices.Clone(j.Needs)
		for _, d := range deferred {
			if slices.Contains(d.Step.For, j.Name) {
				needs = append(needs, d.Name)
			}
		}
		jobs = append(jobs, store.Job{Name: j.Name, Needs: needs})
	}
	planned := store.WithSetup(jobs)
	if len(deferred) == 0 {
		return planned
	}
	out := make([]store.Job, 0, len(planned)+len(deferred))
	out = append(out, planned[0])
	for _, d := range deferred {
		out = append(out, store.Job{Name: d.Name, Needs: []string{store.SetupJob}})
	}
	return append(out, planned[1:]...)
}
