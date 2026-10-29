package scheduler

import (
	"log/slog"
	"slices"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/store"
)

func newSkipHarness(t *testing.T, skip func(store.Run, string) (string, bool)) *harness {
	t.Helper()
	h := newHarness(t, 2)
	_ = h.s.Close()
	h.s = New(h.db, h.runner, Options{Slots: 2, Logger: slog.New(slog.DiscardHandler), Skip: skip})
	t.Cleanup(func() { _ = h.s.Close() })
	h.runner.setAuto()
	return h
}

func skipOnly(names ...string) func(store.Run, string) (string, bool) {
	return func(_ store.Run, job string) (string, bool) {
		return "no match", slices.Contains(names, job)
	}
}

// A job the Skip hook rejects never starts, does not fail the run, and does
// not hold back the jobs that need it.
func TestSkippedJobDoesNotBlockDependents(t *testing.T) {
	h := newSkipHarness(t, skipOnly("a"))
	h.submit(h.create(pushRun("r", "sha1", "main"), job("a"), job("b", "a"), job("c")))
	h.idle()
	h.wantRun("r", store.RunSuccess, "")
	h.wantJob("r", "a", store.JobSkipped, "no match")
	h.wantJob("r", "b", store.JobSuccess, "")
	h.wantJob("r", "c", store.JobSuccess, "")
	wantStarts(t, h.runner, "r:setup", "r:b", "r:c")
}

// A run whose every job is skipped still ends, successfully.
func TestAllJobsSkippedFinishesRun(t *testing.T) {
	h := newSkipHarness(t, skipOnly("a", "b"))
	h.submit(h.create(pushRun("r", "sha1", "main"), job("a"), job("b", "a")))
	h.idle()
	h.wantRun("r", store.RunSuccess, "")
	h.wantJob("r", "b", store.JobSkipped, "no match")
	if got := h.runner.Finishes("r"); !slices.Equal(got, []store.RunState{store.RunSuccess}) {
		t.Errorf("FinishRun calls = %v, want [success]", got)
	}
}

// Skipping does not mask a real failure, and a job skipped behind a failure
// still fails the run.
func TestSkipDoesNotMaskFailure(t *testing.T) {
	h := newSkipHarness(t, skipOnly("c"))
	h.runner.setFail("r:a")
	h.submit(h.create(pushRun("r", "sha1", "main"), job("a"), job("b", "a"), job("c")))
	h.idle()
	h.wantRun("r", store.RunFailed, "job a failed")
	h.wantJob("r", "b", store.JobSkipped, "needs a failed")
	h.wantJob("r", "c", store.JobSkipped, "no match")
}
