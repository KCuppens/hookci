package daemon

import (
	"testing"

	"github.com/KCuppens/hookci/agent/internal/capacity"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/store"
)

func TestJobDemandIsElasticForJobsOnly(t *testing.T) {
	checks := &config.ResolvedChecks{
		Limits: config.ResolvedLimits{CPUs: 2, MemoryBytes: gib},
		Jobs: []config.ResolvedJob{
			{Name: "capped", Limits: config.ResolvedLimits{CPUs: 2, MaxCPUs: 6, MemoryBytes: gib}},
			{Name: "open", Limits: config.ResolvedLimits{CPUs: 2, MemoryBytes: gib}},
		},
	}
	demand := jobDemand(store.Run{}, checks)

	if got, want := demand("capped"), (capacity.Demand{CPUs: 2, MaxCPUs: 6, MemoryBytes: gib}); got != want {
		t.Errorf("capped = %+v, want %+v", got, want)
	}
	if got := demand("open"); got.CPUs != 2 || got.MaxCPUs != capacity.WholeBudget {
		t.Errorf("open = %+v, want min 2 and the whole budget as ceiling", got)
	}
	if got := demand(""); got.CPUs != 2 || got.MaxCPUs != 0 {
		t.Errorf("setup = %+v, want min 2 and no lending", got)
	}
	if jobDemand(store.Run{}, nil) != nil {
		t.Error("nil checks should ask for nothing")
	}
}
