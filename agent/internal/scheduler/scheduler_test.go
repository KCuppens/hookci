package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func wantStarts(t *testing.T, r *fakeRunner, want ...string) {
	t.Helper()
	if got := r.Starts(); !slices.Equal(got, want) {
		t.Fatalf("start order = %v, want %v", got, want)
	}
}

func TestSlotsNeverExceeded(t *testing.T) {
	h := newHarness(t, 2)
	var ids []string
	for i := range 3 {
		n := strconv.Itoa(i)
		ids = append(ids, h.create(pushRun("r"+n, "sha"+n, "ref"+n), indep(4)...))
	}
	for _, id := range ids {
		h.submit(id)
	}

	h.runner.releaseN(t, 3+12)
	for _, id := range ids {
		if st := h.wait(id); st != store.RunSuccess {
			t.Errorf("run %s = %s, want success", id, st)
		}
		for name, j := range h.jobs(id) {
			if j.State != store.JobSuccess {
				t.Errorf("job %s/%s = %s, want success", id, name, j.State)
			}
		}
	}
	if got := h.runner.MaxConcurrent(); got != 2 {
		t.Errorf("MaxConcurrent() = %d, want 2", got)
	}
}

func TestSetupTakesSlot(t *testing.T) {
	h := newHarness(t, 1)
	h.submit(h.create(pushRun("r1", "sha1", "ref1"), indep(2)...))
	h.submit(h.create(pushRun("r2", "sha2", "ref2"), indep(2)...))

	h.runner.releaseN(t, 6)
	h.idle()
	wantStarts(t, h.runner, "r1:setup", "r1:j0", "r1:j1", "r2:setup", "r2:j0", "r2:j1")
	if got := h.runner.MaxConcurrent(); got != 1 {
		t.Errorf("MaxConcurrent() = %d, want 1", got)
	}
}

func TestDeployJumpsQueue(t *testing.T) {
	h := newHarness(t, 1)
	h.submit(h.create(pushRun("c1", "sha1", "ref1"), indep(1)...))
	h.runner.release(t, "c1:setup")
	h.runner.waitStarted(t, "c1:j0")

	h.submit(h.create(pushRun("c2", "sha2", "ref2"), indep(1)...))
	h.submit(h.create(pushRun("c3", "sha3", "ref3"), indep(1)...))
	h.submit(h.create(deployRun("d", "sha4", "production"), indep(1)...))

	h.runner.release(t, "c1:j0")
	h.runner.releaseN(t, 6)
	h.idle()

	wantStarts(t, h.runner, "c1:setup", "c1:j0", "d:setup", "d:j0", "c2:setup", "c2:j0", "c3:setup", "c3:j0")
	for _, id := range []string{"c1", "c2", "c3", "d"} {
		h.wantRun(id, store.RunSuccess, "")
	}
}

func TestEnvLockSerialisesDeploys(t *testing.T) {
	h := newHarness(t, 4)
	h.submit(h.create(deployRun("d1", "sha1", "production"), job("deploy")))
	h.runner.waitStarted(t, "d1:setup")

	h.runner.mu.Lock()
	h.runner.onSetup = func(run store.Run) {
		if run.ID != "d2" {
			return
		}
		if st := h.run("d1").State; !st.Terminal() {
			t.Errorf("d2 setup started while d1 is %s", st)
		}
	}
	h.runner.mu.Unlock()

	h.create(deployRun("d2", "sha2", "production"), job("deploy"))
	if sup := h.submit("d2"); len(sup) != 0 {
		t.Fatalf("Submit(d2) superseded %v, want none", sup)
	}

	h.runner.release(t, "d1:setup")
	h.runner.waitStarted(t, "d1:deploy")
	if slices.Contains(h.runner.Starts(), "d2:setup") {
		t.Fatal("d2 started while d1 holds the env lock")
	}
	h.runner.release(t, "d1:deploy")
	h.runner.release(t, "d2:setup")
	h.runner.release(t, "d2:deploy")

	if st := h.wait("d1"); st != store.RunSuccess {
		t.Errorf("d1 = %s, want success", st)
	}
	if st := h.wait("d2"); st != store.RunSuccess {
		t.Errorf("d2 = %s, want success", st)
	}
}

func TestCancelRunningDeployRefused(t *testing.T) {
	h := newHarness(t, 2)
	h.submit(h.create(deployRun("d", "sha1", "production"), job("deploy")))
	h.runner.waitStarted(t, "d:setup")

	if err := h.s.Cancel(h.ctx, "d", "stop"); !errors.Is(err, ErrDeployNotCancellable) {
		t.Fatalf("Cancel(setup running) = %v, want ErrDeployNotCancellable", err)
	}
	h.runner.release(t, "d:setup")
	h.runner.waitStarted(t, "d:deploy")
	if err := h.s.Cancel(h.ctx, "d", "stop"); !errors.Is(err, ErrDeployNotCancellable) {
		t.Fatalf("Cancel(job running) = %v, want ErrDeployNotCancellable", err)
	}
	h.runner.release(t, "d:deploy")

	if st := h.wait("d"); st != store.RunSuccess {
		t.Fatalf("deploy = %s, want success", st)
	}
	h.wantJob("d", "deploy", store.JobSuccess, "")
}

func TestCancelRunningCheck(t *testing.T) {
	h := newHarness(t, 1)
	h.submit(h.create(pushRun("r", "sha1", "main"), job("a"), job("b", "a")))
	h.runner.release(t, "r:setup")
	h.runner.waitStarted(t, "r:a")

	if err := h.s.Cancel(h.ctx, "r", "user cancelled"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if st := h.wait("r"); st != store.RunFailed {
		t.Fatalf("run = %s, want failed", st)
	}
	h.wantRun("r", store.RunFailed, "user cancelled")
	h.wantJob("r", "a", store.JobCancelled, "user cancelled")
	h.wantJob("r", "b", store.JobSkipped, "user cancelled")
	if got := h.runner.Finishes("r"); !slices.Equal(got, []store.RunState{store.RunFailed}) {
		t.Errorf("FinishRun calls = %v, want [failed]", got)
	}
}

func TestCancelQueued(t *testing.T) {
	h := newHarness(t, 1)
	h.submit(h.create(pushRun("blocker", "sha1", "ref1"), indep(1)...))
	h.runner.waitStarted(t, "blocker:setup")
	h.submit(h.create(pushRun("r", "sha2", "ref2"), indep(1)...))

	if err := h.s.Cancel(h.ctx, "r", "not needed"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if st := h.wait("r"); st != store.RunCancelled {
		t.Fatalf("run = %s, want cancelled", st)
	}
	h.wantRun("r", store.RunCancelled, "not needed")

	h.runner.releaseN(t, 2)
	h.idle()
	wantStarts(t, h.runner, "blocker:setup", "blocker:j0")
	if got := h.runner.Finishes("r"); len(got) != 0 {
		t.Errorf("FinishRun called for a run that never started: %v", got)
	}
}

func TestFinishRunCalledOnce(t *testing.T) {
	wantFinish := func(t *testing.T, h *harness, id string, want store.RunState) {
		t.Helper()
		if got := h.runner.Finishes(id); !slices.Equal(got, []store.RunState{want}) {
			t.Errorf("FinishRun(%s) calls = %v, want [%s]", id, got, want)
		}
	}

	t.Run("success", func(t *testing.T) {
		h := newHarness(t, 2)
		h.runner.setAuto()
		h.submit(h.create(pushRun("r", "sha1", "main"), job("a"), job("b", "a")))
		h.idle()
		h.wantRun("r", store.RunSuccess, "")
		wantFinish(t, h, "r", store.RunSuccess)
	})

	t.Run("failure", func(t *testing.T) {
		h := newHarness(t, 2)
		h.runner.setAuto()
		h.runner.setFail("r:a")
		h.submit(h.create(pushRun("r", "sha1", "main"), job("a"), job("b", "a"), job("c")))
		h.idle()
		h.wantRun("r", store.RunFailed, "job a failed")
		h.wantJob("r", "a", store.JobFailed, "exit 1")
		h.wantJob("r", "b", store.JobSkipped, "needs a failed")
		h.wantJob("r", "c", store.JobSuccess, "")
		wantFinish(t, h, "r", store.RunFailed)
	})

	t.Run("setup failure", func(t *testing.T) {
		h := newHarness(t, 2)
		h.runner.setAuto()
		h.runner.setFail("r:setup")
		h.submit(h.create(pushRun("r", "sha1", "main"), job("a"), job("b", "a")))
		h.idle()
		reason := "setup failed: " + errFake.Error()
		h.wantRun("r", store.RunFailed, reason)
		h.wantJob("r", "a", store.JobSkipped, reason)
		h.wantJob("r", "b", store.JobSkipped, reason)
		wantFinish(t, h, "r", store.RunFailed)
		wantStarts(t, h.runner, "r:setup")
	})

	t.Run("supersede", func(t *testing.T) {
		h := newHarness(t, 2)
		h.runner.setAuto("p1:a")
		h.submit(h.create(prRun("p1", "1111111aaaa", 7), job("a"), job("b", "a")))
		h.runner.waitStarted(t, "p1:a")
		h.submit(h.create(prRun("p2", "2222222bbbb", 7), job("a"), job("b", "a")))
		h.idle()
		h.wantRun("p1", store.RunFailed, "superseded by 2222222")
		h.wantRun("p2", store.RunSuccess, "")
		wantFinish(t, h, "p1", store.RunFailed)
		wantFinish(t, h, "p2", store.RunSuccess)
	})
}

func TestOutboxEventsOrdered(t *testing.T) {
	h := newHarness(t, 2)
	h.runner.setAuto()
	h.submit(h.create(pushRun("r", "sha1", "main"), job("a"), job("b", "a")))
	h.idle()

	items, err := h.db.Pending(h.ctx, 0, 1000)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	var events []protocol.Event
	var last int64
	for _, it := range items {
		if it.Seq <= last {
			t.Fatalf("seq %d after %d, want strictly increasing", it.Seq, last)
		}
		last = it.Seq
		if it.Kind != store.KindEvent {
			continue
		}
		var ev protocol.Event
		if err := json.Unmarshal(it.Payload, &ev); err != nil {
			t.Fatalf("decode event %d: %v", it.Seq, err)
		}
		events = append(events, ev)
	}

	running := -1
	var jobEvents int
	for i, ev := range events {
		switch {
		case ev.Job == nil && ev.State == "running":
			running = i
		case ev.Job != nil:
			jobEvents++
			if running < 0 {
				t.Errorf("job event %s %s before the run went running", *ev.Job, ev.State)
			}
		}
	}
	if running < 0 {
		t.Fatal("no running event for the run")
	}
	if jobEvents != 4 {
		t.Errorf("job events = %d, want 4 (running and success for a and b)", jobEvents)
	}
	if lastEv := events[len(events)-1]; lastEv.Job != nil || lastEv.State != "success" {
		t.Errorf("last event = %+v, want run success", lastEv)
	}
}

func TestCloseInterruptsRunning(t *testing.T) {
	h := newHarness(t, 1)
	h.submit(h.create(pushRun("r", "sha1", "ref1"), job("a"), job("b", "a")))
	h.runner.release(t, "r:setup")
	h.runner.waitStarted(t, "r:a")
	h.submit(h.create(pushRun("q", "sha2", "ref2"), indep(1)...))

	if err := h.s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	h.wantRun("r", store.RunInterrupted, closedReason)
	h.wantJob("r", "a", store.JobInterrupted, closedReason)
	h.wantJob("r", "b", store.JobInterrupted, closedReason)
	h.wantRun("q", store.RunQueued, "")
	if got := h.runner.Finishes("r"); !slices.Equal(got, []store.RunState{store.RunInterrupted}) {
		t.Errorf("FinishRun calls = %v, want [interrupted]", got)
	}

	if _, err := h.s.Submit(h.ctx, "q"); !errors.Is(err, ErrClosed) {
		t.Errorf("Submit after Close = %v, want ErrClosed", err)
	}
	if _, err := h.s.Wait(h.ctx, "q"); !errors.Is(err, ErrClosed) {
		t.Errorf("Wait(queued) after Close = %v, want ErrClosed", err)
	}
	if st, err := h.s.Wait(h.ctx, "r"); err != nil || st != store.RunInterrupted {
		t.Errorf("Wait(r) after Close = %s, %v, want interrupted", st, err)
	}
}

func TestWaitUnsubmitted(t *testing.T) {
	h := newHarness(t, 1)
	h.create(pushRun("r", "sha1", "main"), job("a"))
	ctx, cancel := context.WithCancel(h.ctx)
	defer cancel()
	if _, err := h.s.Wait(ctx, "r"); err == nil {
		t.Fatal("Wait on a queued run that was never submitted returned no error")
	}
	if err := h.db.Transition(h.ctx, "r", []store.RunState{store.RunQueued}, store.RunCancelled, ""); err != nil {
		t.Fatalf("Transition: %v", err)
	}
	if st, err := h.s.Wait(ctx, "r"); err != nil || st != store.RunCancelled {
		t.Fatalf("Wait on a terminal run = %s, %v, want cancelled", st, err)
	}
}
