package daemon

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/deploy/trigger"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// fakeDeploys answers deploy triggers from canned decisions by trigger id
// and records the ids it was asked about.
type fakeDeploys struct {
	decisions map[string]trigger.Decision
	errs      map[string]error
	mu        sync.Mutex
	calls     []string
}

func (f *fakeDeploys) Handle(_ context.Context, t protocol.Trigger) (trigger.Decision, error) {
	f.mu.Lock()
	f.calls = append(f.calls, t.TriggerId)
	f.mu.Unlock()
	return f.decisions[t.TriggerId], f.errs[t.TriggerId]
}

func (f *fakeDeploys) called() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (h *harness) deployTrigger(id, env string) protocol.Trigger {
	t := h.trigger(id, false)
	t.Env = &env
	return t
}

func TestDaemonDeployTriggers(t *testing.T) {
	const untrusted = "deployments.prod: untrusted trigger cannot deploy"
	deploys := &fakeDeploys{
		decisions: map[string]trigger.Decision{
			"trg_ok":   {Accepted: true, RunID: "run_deploy"},
			"trg_no":   {Reason: untrusted},
			"trg_last": {Accepted: true, RunID: "run_last"},
		},
		errs: map[string]error{"trg_err": errors.New("trigger: github /repos/acme/app/branches/main: 502")},
	}
	h := newHarnessWith(t, &fakeSource{Head: map[string]string{ConfigFile: unitOnly}}, &fakeRunner{}, "https://hub.invalid", deploys)

	ok := h.deployTrigger("trg_ok", "prod")
	h.send(ok)
	h.send(ok) // resent while queued or being decided
	h.send(h.deployTrigger("trg_no", "prod"))
	h.send(h.deployTrigger("trg_err", "prod"))
	h.send(h.trigger("trg_ci", false)) // no env: the checks path
	h.waitTrigger("trg_ok", store.TriggerDone)
	h.waitTrigger("trg_no", store.TriggerRejected)
	h.waitTrigger("trg_err", store.TriggerRejected)
	h.waitTrigger("trg_ci", store.TriggerDone)

	h.send(ok) // resent after it was answered
	h.send(h.deployTrigger("trg_last", "prod"))
	h.waitTrigger("trg_last", store.TriggerDone)

	if got, want := deploys.called(), []string{"trg_ok", "trg_no", "trg_err", "trg_last"}; !slices.Equal(got, want) {
		t.Errorf("intake calls = %v, want %v", got, want)
	}
	accepted := map[string]any{}
	for _, f := range h.frames("accepted") {
		accepted[f["trigger_id"].(string)] = f["run_id"]
	}
	if len(accepted) != 3 || accepted["trg_ok"] != "run_deploy" || accepted["trg_last"] != "run_last" || accepted["trg_ci"] == nil {
		t.Errorf("accepted frames = %v, want trg_ok, trg_last and trg_ci once each", h.frames("accepted"))
	}
	rejected := map[string]any{}
	for _, f := range h.frames("rejected") {
		rejected[f["trigger_id"].(string)] = f["reason"]
	}
	want := map[string]any{
		"trg_no":  untrusted,
		"trg_err": "deployments.prod: github check failed: trigger: github /repos/acme/app/branches/main: 502; the hub may redeliver",
	}
	if len(rejected) != len(want) || rejected["trg_no"] != want["trg_no"] || rejected["trg_err"] != want["trg_err"] {
		t.Errorf("rejected frames = %v, want %v", rejected, want)
	}
	// Only the checks trigger checked out and ran.
	if len(h.execs) != 1 || h.runCount() != 1 {
		t.Errorf("executions = %v, runs = %d; want only trg_ci", h.execs, h.runCount())
	}
}

// TestHubIntakeChecksGitHubWithTriggerToken drives the default intake
// against a fake GitHub: every call carries the one token the hub issued for
// the trigger id, and the accepted run lands in the store.
func TestHubIntakeChecksGitHubWithTriggerToken(t *testing.T) {
	const cfg = "version: 1\ndeployments:\n  prod:\n    on: { push: main }\n    strategy: script\n    run: ./deploy.sh\n"
	var mu sync.Mutex
	var auths, paths []string
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		auths = append(auths, r.Header.Get("Authorization"))
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		switch r.URL.Path {
		case "/repos/acme/app/contents/.zeroci.yml":
			_, _ = w.Write([]byte(cfg))
		case "/repos/acme/app/branches/main":
			_, _ = w.Write([]byte(`{"protected":true}`))
		case "/repos/acme/app/compare/main..." + headSHA:
			_, _ = w.Write([]byte(`{"status":"identical"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(gh.Close)
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	var asked []string
	in := &hubIntake{
		base:      trigger.Intake{Store: st, Clock: func() time.Time { return time.Unix(1_700_000_000, 0) }, NewRunID: func() string { return "run_d" }},
		githubURL: gh.URL,
		http:      gh.Client(),
		tokens: func(_ context.Context, id string) (string, error) {
			asked = append(asked, id)
			return "ghs_fetch", nil
		},
	}
	env := "prod"
	dec, err := in.Handle(context.Background(), protocol.Trigger{
		Attempt: 1, Env: &env, Event: protocol.TriggerEventPush, Ref: "refs/heads/main", Repo: "acme/app",
		Sha: headSHA, TriggerId: "trg_1", Trust: protocol.TriggerTrustTrusted,
	})
	if err != nil || !dec.Accepted || dec.RunID != "run_d" {
		t.Fatalf("Handle = %+v, %v; want accepted as run_d", dec, err)
	}
	if !slices.Equal(asked, []string{"trg_1"}) {
		t.Errorf("token requests = %v, want one for trg_1", asked)
	}
	if len(paths) != 3 {
		t.Errorf("GitHub calls = %v, want config, branch and compare", paths)
	}
	for _, a := range auths {
		if a != "Bearer ghs_fetch" {
			t.Errorf("Authorization = %q, want the hub token", a)
		}
	}
	run, err := st.FindDeployRun(context.Background(), "acme/app", "prod", headSHA, 1)
	if err != nil || run.RunID != "run_d" || run.State != store.DeployQueued {
		t.Errorf("stored run = %+v, %v; want run_d queued", run, err)
	}
}
