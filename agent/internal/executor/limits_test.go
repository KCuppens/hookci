package executor

import (
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func TestEffectiveLimitsUntrustedCap(t *testing.T) {
	big := config.ResolvedLimits{CPUs: 8, MemoryBytes: 16 << 30, Tasks: 4096, Timeout: time.Hour}

	got := EffectiveLimits(store.Run{TrustDomain: "untrusted:o/r"}, big, config.ResolvedJob{})
	want := isolation.Limits{CPUs: 2, MemoryBytes: 2 << 30, Tasks: 512, Timeout: 10 * time.Minute}
	if got != want {
		t.Errorf("untrusted = %+v, want %+v", got, want)
	}

	got = EffectiveLimits(store.Run{TrustDomain: "untrusted:o/r"}, config.ResolvedLimits{}, config.ResolvedJob{})
	if want := (isolation.Limits{CPUs: 2, MemoryBytes: 2 << 30, Tasks: 512, Timeout: 10 * time.Minute}); got != want {
		t.Errorf("untrusted unset = %+v, want the cap %+v", got, want)
	}

	small := config.ResolvedLimits{CPUs: 1, MemoryBytes: 1 << 30, Tasks: 64, Timeout: time.Minute}
	got = EffectiveLimits(store.Run{TrustDomain: "untrusted:o/r"}, small, config.ResolvedJob{})
	if want := (isolation.Limits{CPUs: 1, MemoryBytes: 1 << 30, Tasks: 64, Timeout: time.Minute}); got != want {
		t.Errorf("untrusted under cap = %+v, want %+v", got, want)
	}

	got = EffectiveLimits(store.Run{TrustDomain: "trusted:o/r"}, big, config.ResolvedJob{})
	if want := (isolation.Limits{CPUs: 8, MemoryBytes: 16 << 30, Tasks: 4096, Timeout: time.Hour}); got != want {
		t.Errorf("trusted = %+v, want %+v", got, want)
	}
}

func TestEffectiveLimitsJobOverride(t *testing.T) {
	checks := config.ResolvedLimits{CPUs: 2, MemoryBytes: 4 << 30, Tasks: 512, Timeout: 10 * time.Minute}
	job := config.ResolvedJob{Limits: config.ResolvedLimits{CPUs: 4, Timeout: 30 * time.Minute}}
	got := EffectiveLimits(store.Run{TrustDomain: "trusted:o/r"}, checks, job)
	want := isolation.Limits{CPUs: 4, MemoryBytes: 4 << 30, Tasks: 512, Timeout: 30 * time.Minute}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}
