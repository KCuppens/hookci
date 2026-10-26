package daemon

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/agentconf"
	"github.com/KCuppens/hookci/agent/internal/capacity"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/executor"
	"github.com/KCuppens/hookci/agent/internal/hubclient"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/scheduler"
	"github.com/KCuppens/hookci/agent/internal/source"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// newHarnessPool is newHarness with triggers admitted by pool instead of
// unconditionally, so the lane cap it derives (Daemon.maxLanes) applies.
func newHarnessPool(t *testing.T, src *fakeSource, runner *fakeRunner, pool *capacity.Pool, def Budget) *harness {
	t.Helper()
	stateDir := t.TempDir()
	runner.stateDir = stateDir
	st, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	src.started = make(chan struct{})
	runner.running = make(chan string, 16)
	h := &harness{t: t, st: st, src: src, runner: runner}
	exec := func(_ source.Checkout, checks *config.ResolvedChecks, policy executor.RunPolicy, cacheFallback []string) (scheduler.JobRunner, error) {
		var names []string
		for _, j := range checks.Jobs {
			names = append(names, j.Name)
		}
		h.mu.Lock()
		h.execs = append(h.execs, names)
		h.policies = append(h.policies, policy)
		h.fallbacks = append(h.fallbacks, cacheFallback)
		h.mu.Unlock()
		return runner, nil
	}
	conf := &agentconf.AgentConfig{HubURL: "https://hub.invalid", AgentID: "agt_1", Credential: "hci_agent_x"}
	dialer := &idleDialer{dialed: make(chan struct{})}
	noHub := func(context.Context) (hubclient.HubInfo, error) {
		return hubclient.HubInfo{}, errors.New("hub unreachable")
	}
	h.d = New(conf, st, exec, Options{StateDir: stateDir, Dialer: dialer, Source: src, Slots: 2, Pool: pool, BudgetDefault: def, DeployRunner: noDeployUnits(), HubInfo: noHub})

	ctx, cancel := context.WithCancel(context.Background())
	h.ctx = ctx
	done := make(chan error, 1)
	go func() { done <- h.d.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != context.Canceled {
			t.Errorf("Run = %v, want context.Canceled", err)
		}
	})
	<-dialer.dialed
	return h
}

// finish ends the still-running trigger id (its run blocked in RunJob) by
// superseding it, the way lanes_test.go does.
func finish(h *harness, id string) {
	h.t.Helper()
	tr := h.waitTrigger(id, store.TriggerRunning)
	runID := tr.RunID
	h.send(protocol.Interrupt{RunId: &runID, Reason: protocol.InterruptReasonSuperseded, Seq: new(100)})
	h.waitTrigger(id, store.TriggerDone)
}

// TestDaemonLaneCapFromBudget: the agent never runs more lanes at once than
// its CPU budget covers at config.DefaultJobCPUs per lane, even though
// every lane here is otherwise free to start (idle, same trust).
func TestDaemonLaneCapFromBudget(t *testing.T) {
	src := &fakeSource{Head: map[string]string{ConfigFile: unitOnly}, Base: map[string]string{ConfigFile: unitOnly}}
	pool := capacity.New(capacity.Options{CPUCount: 16})
	h := newHarnessPool(t, src, &fakeRunner{Block: true}, pool, Budget{CPUs: 2 * config.DefaultJobCPUs})

	send := func(id, branch, sha string) {
		tr := h.trigger(id, false)
		tr.Ref = "refs/heads/" + branch
		tr.Sha = strings.Repeat(sha, 40)
		h.send(tr)
	}
	send("b1", "b1", "a")
	send("b2", "b2", "b")
	send("b3", "b3", "c")

	for range 2 {
		select {
		case <-h.runner.running:
		case <-time.After(10 * time.Second):
			t.Fatal("the two lanes the budget covers did not both start")
		}
	}
	select {
	case job := <-h.runner.running:
		t.Fatalf("a third lane %q started past the budget-derived cap", job)
	case <-time.After(100 * time.Millisecond):
	}
	h.waitTrigger("b3", store.TriggerAccepted)
}

// TestDaemonPriorityMasterBeforePR: with the lane cap holding a slot back,
// a push to the default branch queued after a pull request still starts
// first once a slot frees up.
func TestDaemonPriorityMasterBeforePR(t *testing.T) {
	src := &fakeSource{Head: map[string]string{ConfigFile: unitOnly}, Base: map[string]string{ConfigFile: unitOnly}}
	pool := capacity.New(capacity.Options{CPUCount: 16})
	h := newHarnessPool(t, src, &fakeRunner{Block: true}, pool, Budget{CPUs: config.DefaultJobCPUs})

	busy := h.trigger("busy", false)
	busy.Ref = "refs/heads/busy"
	busy.Sha = strings.Repeat("a", 40)
	h.send(busy)
	<-h.runner.running

	pr := h.trigger("pr_7", true)
	pr.Sha = strings.Repeat("b", 40)
	h.send(pr)
	master := h.trigger("master_1", false)
	master.Sha = strings.Repeat("c", 40)
	h.send(master)
	h.waitTrigger("pr_7", store.TriggerAccepted)
	h.waitTrigger("master_1", store.TriggerAccepted)

	finish(h, "busy")
	select {
	case <-h.runner.running:
	case <-time.After(10 * time.Second):
		t.Fatal("next trigger did not start once the lane freed up")
	}
	h.waitTrigger("master_1", store.TriggerRunning)
	h.waitTrigger("pr_7", store.TriggerAccepted)
}

// TestDaemonPriorityStagingBetweenMasterAndPR: push to "staging" starts
// before a pull request but after a push to the default branch.
func TestDaemonPriorityStagingBetweenMasterAndPR(t *testing.T) {
	src := &fakeSource{Head: map[string]string{ConfigFile: unitOnly}, Base: map[string]string{ConfigFile: unitOnly}}
	pool := capacity.New(capacity.Options{CPUCount: 16})
	h := newHarnessPool(t, src, &fakeRunner{Block: true}, pool, Budget{CPUs: config.DefaultJobCPUs})

	busy := h.trigger("busy", false)
	busy.Ref = "refs/heads/busy"
	busy.Sha = strings.Repeat("a", 40)
	h.send(busy)
	<-h.runner.running

	pr := h.trigger("pr_7", true)
	pr.Sha = strings.Repeat("b", 40)
	h.send(pr)
	staging := h.trigger("staging_1", false)
	staging.Ref = "refs/heads/staging"
	staging.Sha = strings.Repeat("c", 40)
	h.send(staging)
	h.waitTrigger("pr_7", store.TriggerAccepted)
	h.waitTrigger("staging_1", store.TriggerAccepted)

	finish(h, "busy")
	select {
	case <-h.runner.running:
	case <-time.After(10 * time.Second):
		t.Fatal("next trigger did not start once the lane freed up")
	}
	h.waitTrigger("staging_1", store.TriggerRunning)
	h.waitTrigger("pr_7", store.TriggerAccepted)
}
