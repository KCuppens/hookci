package executor

import (
	"context"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/capacity"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/isolation"
	"github.com/KCuppens/hookci/agent/internal/store"
)

const gib = int64(1) << 30

// calmHost is a host with pressure stall information and nothing going on,
// so a pool lends idle CPU.
type calmHost struct{}

func (calmHost) Sample() (capacity.Sample, error) {
	return capacity.Sample{MemTotal: 64 * gib, MemAvailable: 60 * gib, PSI: true}, nil
}

func newPool(cpus float64) *capacity.Pool {
	return capacity.New(capacity.Options{CPUs: cpus, MemoryBytes: 16 * gib, Host: calmHost{}, CPUCount: 16})
}

func TestRunJobUsesGrantedCPUs(t *testing.T) {
	cfg := &config.ResolvedChecks{
		Limits: config.ResolvedLimits{CPUs: 2, MaxCPUs: 6, MemoryBytes: gib},
		Jobs:   []config.ResolvedJob{{Name: "build", Run: "make"}},
	}
	h := newHarness(t, "none", cfg, nil)
	run := localRun()
	h.create(t, run, cfg)
	setUp(t, h, run)

	g, ok := newPool(8).TryAcquire(capacity.Demand{CPUs: 2, MaxCPUs: 6, MemoryBytes: gib})
	if !ok {
		t.Fatal("pool refused the job")
	}
	defer g.Release()
	if _, err := h.ex.RunJob(capacity.WithGrant(context.Background(), g), run, job("build")); err != nil {
		t.Fatal(err)
	}
	finish(t, h, run, store.RunSuccess)

	s := h.iso.spec(t, "build")
	if s.Limits.CPUs != 6 {
		t.Errorf("Limits.CPUs = %v, want the granted 6", s.Limits.CPUs)
	}
	if !hasEnv(s.Env, "HOOKCI_CPUS=6") {
		t.Errorf("env lacks HOOKCI_CPUS=6: %q", s.Env)
	}
}

func TestRunJobWithoutGrantUsesLimit(t *testing.T) {
	cfg := &config.ResolvedChecks{
		Limits: config.ResolvedLimits{CPUs: 2, MemoryBytes: gib},
		Jobs:   []config.ResolvedJob{{Name: "build", Run: "make"}},
	}
	h := newHarness(t, "none", cfg, nil)
	run := localRun()
	h.create(t, run, cfg)
	setUp(t, h, run)
	if _, err := h.ex.RunJob(context.Background(), run, job("build")); err != nil {
		t.Fatal(err)
	}
	finish(t, h, run, store.RunSuccess)
	if s := h.iso.spec(t, "build"); !hasEnv(s.Env, "HOOKCI_CPUS=2") {
		t.Errorf("env lacks HOOKCI_CPUS=2: %q", s.Env)
	}
}

func TestRunJobAppliesCPUChangesWhileRunning(t *testing.T) {
	cfg := &config.ResolvedChecks{
		Limits: config.ResolvedLimits{CPUs: 2, MaxCPUs: 6, MemoryBytes: gib},
		Jobs:   []config.ResolvedJob{{Name: "build", Run: "make"}},
	}
	h := newHarness(t, "systemd", cfg, nil)
	h.iso.resized = make(chan float64, 16)
	run := localRun()
	h.create(t, run, cfg)
	setUp(t, h, run)

	started := make(chan struct{})
	finishJob := make(chan struct{})
	h.iso.jobs["build"] = func(context.Context, isolation.Spec) (isolation.Result, error) {
		close(started)
		<-finishJob
		return isolation.Result{}, nil
	}

	pool := newPool(8)
	g, ok := pool.TryAcquire(capacity.Demand{CPUs: 2, MaxCPUs: 6, MemoryBytes: gib})
	if !ok {
		t.Fatal("pool refused the job")
	}
	defer g.Release()

	done := make(chan error, 1)
	go func() {
		_, err := h.ex.RunJob(capacity.WithGrant(context.Background(), g), run, job("build"))
		done <- err
	}()
	<-started

	// A second job's minimum leaves the first only 8 - 4 CPUs to be lent.
	other, ok := pool.TryAcquire(capacity.Demand{CPUs: 4})
	if !ok {
		t.Fatal("pool refused the second job")
	}
	expectResize(t, h.iso.resized, 4)

	other.Release()
	expectResize(t, h.iso.resized, 6)

	close(finishJob)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	finish(t, h, run, store.RunSuccess)
}

func expectResize(t *testing.T, ch <-chan float64, want float64) {
	t.Helper()
	select {
	case got := <-ch:
		if got != want {
			t.Fatalf("SetCPUs(%v), want %v", got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("no SetCPUs(%v)", want)
	}
}
