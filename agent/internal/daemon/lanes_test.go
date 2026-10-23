package daemon

import (
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// TestDaemonLanes: triggers of different lanes run side by side, a later
// trigger of a busy lane waits for it and then runs.
func TestDaemonLanes(t *testing.T) {
	src := &fakeSource{Head: map[string]string{ConfigFile: unitOnly}, Base: map[string]string{ConfigFile: unitOnly}}
	h := newHarness(t, src, &fakeRunner{Block: true})
	send := func(id string, pr bool, ref, sha string) {
		tr := h.trigger(id, pr)
		if ref != "" {
			tr.Ref = ref
		}
		tr.Sha = strings.Repeat(sha, 40)
		h.send(tr)
	}
	send("main_1", false, "", "a")
	send("pr_7", true, "", "b")
	send("main_2", false, "", "c")
	send("dev_1", false, "refs/heads/develop", "d")

	for range 3 {
		select {
		case <-h.runner.running:
		case <-time.After(10 * time.Second):
			t.Fatal("main, the pull request and develop did not all start")
		}
	}
	first := h.waitTrigger("main_1", store.TriggerRunning)
	h.waitTrigger("pr_7", store.TriggerRunning)
	h.waitTrigger("dev_1", store.TriggerRunning)
	select {
	case job := <-h.runner.running:
		t.Fatalf("a fourth job %q started while main was busy", job)
	case <-time.After(100 * time.Millisecond):
	}
	h.waitTrigger("main_2", store.TriggerAccepted)

	runID := first.RunID
	h.send(protocol.Interrupt{RunId: &runID, Reason: protocol.InterruptReasonSuperseded, Seq: new(100)})
	h.waitTrigger("main_1", store.TriggerDone)
	select {
	case <-h.runner.running:
	case <-time.After(10 * time.Second):
		t.Fatal("main's next trigger did not start after the first finished")
	}
	h.waitTrigger("main_2", store.TriggerRunning)
}

// TestDaemonLanesSplitTrust: an untrusted run never overlaps a trusted one,
// and a trusted trigger queued behind a held-back untrusted one waits too.
func TestDaemonLanesSplitTrust(t *testing.T) {
	src := &fakeSource{Head: map[string]string{ConfigFile: unitOnly}, Base: map[string]string{ConfigFile: unitOnly}}
	h := newHarness(t, src, &fakeRunner{Block: true})
	main := h.trigger("main_1", false)
	main.Sha = strings.Repeat("a", 40)
	h.send(main)
	first := h.waitTrigger("main_1", store.TriggerRunning)
	<-h.runner.running

	fork := h.trigger("fork_7", true)
	fork.Sha = strings.Repeat("b", 40)
	fork.Trust = protocol.TriggerTrustUntrusted
	h.send(fork)
	dev := h.trigger("dev_1", false)
	dev.Ref, dev.Sha = "refs/heads/develop", strings.Repeat("c", 40)
	h.send(dev)
	select {
	case job := <-h.runner.running:
		t.Fatalf("job %q started next to the trusted run", job)
	case <-time.After(100 * time.Millisecond):
	}
	h.waitTrigger("fork_7", store.TriggerAccepted)
	h.waitTrigger("dev_1", store.TriggerAccepted)

	runID := first.RunID
	h.send(protocol.Interrupt{RunId: &runID, Reason: protocol.InterruptReasonSuperseded, Seq: new(100)})
	h.waitTrigger("fork_7", store.TriggerRunning)
	<-h.runner.running
	select {
	case job := <-h.runner.running:
		t.Fatalf("job %q started next to the untrusted run", job)
	case <-time.After(100 * time.Millisecond):
	}
	h.waitTrigger("dev_1", store.TriggerAccepted)
}
