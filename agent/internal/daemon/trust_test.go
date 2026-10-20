package daemon

import (
	"slices"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/executor"
	"github.com/KCuppens/hookci/agent/internal/ids"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/store"
)

func TestOptionsForTrustUntrusted(t *testing.T) {
	for _, trust := range []protocol.TriggerTrust{protocol.TriggerTrustUntrusted, "", "unknown"} {
		p := optionsForTrust(trust)
		if p.AllowSecrets {
			t.Errorf("optionsForTrust(%q) allows secrets", trust)
		}
		if p.AllowDeploy {
			t.Errorf("optionsForTrust(%q) allows deploy", trust)
		}
		if !p.EgressProxyOnly {
			t.Errorf("optionsForTrust(%q) allows direct egress", trust)
		}
	}
}

func TestOptionsForTrustTrusted(t *testing.T) {
	want := executor.RunPolicy{AllowSecrets: true, AllowDeploy: true, EgressProxyOnly: false}
	if got := optionsForTrust(protocol.TriggerTrustTrusted); got != want {
		t.Fatalf("optionsForTrust(trusted) = %+v, want %+v", got, want)
	}
}

func TestDaemonPassesTrustPolicy(t *testing.T) {
	h := newHarness(t, &fakeSource{
		Head: map[string]string{ConfigFile: unitOnly},
		Base: map[string]string{ConfigFile: unitOnly},
	}, &fakeRunner{})
	tr := h.trigger("trg_1", true)
	tr.Trust = protocol.TriggerTrustUntrusted
	h.send(tr)
	got := h.waitTrigger("trg_1", store.TriggerDone)

	want := []executor.RunPolicy{{AllowSecrets: false, AllowDeploy: false, EgressProxyOnly: true}}
	if !slices.Equal(h.policies, want) {
		t.Fatalf("executor policies = %+v, want %+v", h.policies, want)
	}
	run, err := h.st.GetRun(h.ctx, got.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if run.TrustDomain != "untrusted:acme/app" || run.State != store.RunSuccess {
		t.Fatalf("run = %+v, want a successful untrusted:acme/app run", run)
	}
}

// deployRun stores a queued deploy run of trigger id with jobs deploy and
// migrate, and returns its work and run.
func deployRun(h *harness, id string, trust protocol.TriggerTrust) (*work, store.Run) {
	h.t.Helper()
	tr := h.trigger(id, false)
	tr.Trust = trust
	runID := ids.NewRunID()
	if _, err := h.st.AcceptTrigger(h.ctx, id, runID); err != nil {
		h.t.Fatal(err)
	}
	run := storeRun(tr, runID, headSHA)
	run.Kind = kindDeploy
	jobs := []store.Job{{Name: "deploy"}, {Name: "migrate", Needs: []string{"deploy"}}}
	if err := h.st.CreateRun(h.ctx, run, jobs); err != nil {
		h.t.Fatal(err)
	}
	return &work{trig: tr, runID: runID}, run
}

func TestDaemonSkipsUntrustedDeploy(t *testing.T) {
	h := newHarness(t, &fakeSource{}, &fakeRunner{})
	w, run := deployRun(h, "trg_1", protocol.TriggerTrustUntrusted)

	h.d.drive(h.ctx, w, run, h.runner, optionsForTrust(protocol.TriggerTrustUntrusted))

	if len(h.runner.jobs) != 0 {
		t.Fatalf("jobs run = %v, want none", h.runner.jobs)
	}
	jobs, err := h.st.Jobs(h.ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, j := range jobs {
		if j.State != store.JobSkipped || j.Reason != reasonUntrustedDeploy {
			t.Errorf("job %s = %s (%q), want skipped (%q)", j.Name, j.State, j.Reason, reasonUntrustedDeploy)
		}
	}
	skipped := map[string]bool{}
	for _, ev := range h.frames("event") {
		if ev["run_id"] != run.ID || ev["job"] == nil {
			continue
		}
		if ev["state"] != "skipped" || ev["step"] != "untrusted" {
			t.Errorf("job event = %v, want state skipped, step untrusted", ev)
		}
		skipped[ev["job"].(string)] = true
	}
	if !skipped["deploy"] || !skipped["migrate"] {
		t.Fatalf("skipped job events = %v, want deploy and migrate", skipped)
	}
	got, err := h.st.GetRun(h.ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != store.RunCancelled {
		t.Fatalf("run state = %s, want cancelled", got.State)
	}
	h.waitTrigger("trg_1", store.TriggerDone)
}

func TestDaemonRunsTrustedDeploy(t *testing.T) {
	h := newHarness(t, &fakeSource{}, &fakeRunner{})
	w, run := deployRun(h, "trg_1", protocol.TriggerTrustTrusted)

	h.d.drive(h.ctx, w, run, h.runner, optionsForTrust(protocol.TriggerTrustTrusted))

	if !slices.Equal(h.runner.jobs, []string{"deploy", "migrate"}) {
		t.Fatalf("jobs run = %v, want [deploy migrate]", h.runner.jobs)
	}
	got, err := h.st.GetRun(h.ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != store.RunSuccess {
		t.Fatalf("run state = %s, want success", got.State)
	}
}
