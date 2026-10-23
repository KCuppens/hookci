package scheduler

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// jobEvents returns the outbox events of job in order.
func (h *harness) jobEvents(job string) []protocol.Event {
	h.t.Helper()
	items, err := h.db.Pending(h.ctx, 0, 1000)
	if err != nil {
		h.t.Fatalf("Pending: %v", err)
	}
	var out []protocol.Event
	for _, it := range items {
		if it.Kind != store.KindEvent {
			continue
		}
		var ev protocol.Event
		if err := json.Unmarshal(it.Payload, &ev); err != nil {
			h.t.Fatalf("decode event %d: %v", it.Seq, err)
		}
		if ev.Job != nil && *ev.Job == job {
			out = append(out, ev)
		}
	}
	return out
}

func eventStates(evs []protocol.Event) []string {
	var states []string
	for _, ev := range evs {
		states = append(states, string(ev.State))
	}
	return states
}

// createPlanned stores run the way the agent plans it: setup in front, and
// every job without needs behind it.
func (h *harness) createPlanned(run store.Run, jobs ...store.Job) string {
	h.t.Helper()
	return h.create(run, store.WithSetup(jobs)...)
}

// The setup job runs first and alone: it is running while setup runs, the
// jobs stay queued however many slots are free, and they start only once it
// succeeded.
func TestSetupJobGatesJobs(t *testing.T) {
	h := newHarness(t, 4)
	h.submit(h.createPlanned(pushRun("r", "sha1", "main"), job("a"), job("b"), job("c", "a")))
	h.runner.waitStarted(t, "r:setup")

	h.wantJob("r", "setup", store.JobRunning, "")
	for _, name := range []string{"a", "b", "c"} {
		h.wantJob("r", name, store.JobQueued, "")
	}
	wantStarts(t, h.runner, "r:setup")

	h.runner.release(t, "r:setup")
	h.runner.waitStarted(t, "r:a")
	h.runner.waitStarted(t, "r:b")
	h.wantJob("r", "setup", store.JobSuccess, "")
	h.wantJob("r", "c", store.JobQueued, "")

	h.runner.release(t, "r:a")
	h.runner.release(t, "r:b")
	h.runner.release(t, "r:c")
	if st := h.wait("r"); st != store.RunSuccess {
		t.Fatalf("run = %s, want success", st)
	}
	h.wantRun("r", store.RunSuccess, "")
	if j := h.jobs("r")["setup"]; j.DurationMS == nil {
		t.Errorf("setup job has no duration: %+v", j)
	}
	wantStarts(t, h.runner, "r:setup", "r:a", "r:b", "r:c")
	if got := eventStates(h.jobEvents("setup")); !slices.Equal(got, []string{"running", "success"}) {
		t.Errorf("setup job events = %v, want running then success", got)
	}
}

// A failed setup fails the setup job with its tail, skips every job behind
// it as needing setup, and fails the run with the setup reason.
func TestSetupJobFailure(t *testing.T) {
	h := newHarness(t, 2)
	h.runner.setAuto()
	h.runner.setFail("r:setup")
	h.runner.setupOut = JobOutcome{Tail: []string{"npm ERR! missing lockfile"}}
	h.submit(h.createPlanned(pushRun("r", "sha1", "main"), job("a"), job("b", "a"), job("c")))
	h.idle()

	reason := errFake.Error()
	h.wantRun("r", store.RunFailed, "setup failed: "+reason)
	h.wantJob("r", "setup", store.JobFailed, reason)
	for _, name := range []string{"a", "b", "c"} {
		h.wantJob("r", name, store.JobSkipped, "needs setup failed")
	}
	wantStarts(t, h.runner, "r:setup")
	if got := h.runner.Finishes("r"); !slices.Equal(got, []store.RunState{store.RunFailed}) {
		t.Errorf("FinishRun calls = %v, want [failed]", got)
	}

	evs := h.jobEvents("setup")
	last := evs[len(evs)-1]
	if last.State != "failed" || last.DurationMs == nil || !slices.Equal(last.Tail, []string{"npm ERR! missing lockfile"}) {
		t.Errorf("last setup event = %+v, want failed with duration and tail", last)
	}
}

// logs: local keeps the setup log on the agent, and the event says so.
func TestSetupJobLogsLocal(t *testing.T) {
	h := newHarness(t, 2)
	h.runner.setAuto()
	h.runner.setupOut = JobOutcome{LogsLocal: true}
	h.submit(h.createPlanned(pushRun("r", "sha1", "main"), job("a")))
	h.idle()

	evs := h.jobEvents("setup")
	last := evs[len(evs)-1]
	if last.State != "success" || last.Logs == nil || *last.Logs != protocol.EventLogsLocal {
		t.Errorf("last setup event = %+v, want success with logs: local", last)
	}
}

// Cancelling during setup cancels the setup job, skips the rest and ends the
// run cancelled.
func TestSetupJobCancelledDuringSetup(t *testing.T) {
	h := newHarness(t, 2)
	h.submit(h.createPlanned(pushRun("r", "sha1", "main"), job("a")))
	h.runner.waitStarted(t, "r:setup")

	if err := h.s.Cancel(h.ctx, "r", "user cancelled"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if st := h.wait("r"); st != store.RunCancelled {
		t.Fatalf("run = %s, want cancelled", st)
	}
	h.wantRun("r", store.RunCancelled, "user cancelled")
	h.wantJob("r", "setup", store.JobCancelled, "user cancelled")
	h.wantJob("r", "a", store.JobSkipped, "user cancelled")
	wantStarts(t, h.runner, "r:setup")
}

// A run planned before setup became a job has no setup row: setup still runs
// first and a failure still fails the run, as before.
func TestRunWithoutSetupJobKeepsOldBehaviour(t *testing.T) {
	h := newHarness(t, 2)
	h.runner.setAuto()
	h.runner.setFail("r:setup")
	h.submit(h.create(pushRun("r", "sha1", "main"), job("a")))
	h.idle()

	reason := "setup failed: " + errFake.Error()
	h.wantRun("r", store.RunFailed, reason)
	h.wantJob("r", "a", store.JobSkipped, reason)
	if _, ok := h.jobs("r")["setup"]; ok {
		t.Error("a setup job appeared in a run planned without one")
	}
	if got := h.jobEvents("setup"); len(got) != 0 {
		t.Errorf("setup job events = %v, want none", got)
	}
}
