package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/agentconf"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/trigger"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/hubclient"
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
	setDeployRetryBase(t, time.Millisecond)
	const untrusted = "deployments.prod: untrusted trigger cannot deploy"
	deploys := &fakeDeploys{
		decisions: map[string]trigger.Decision{
			"trg_ok":   {Accepted: true, RunID: "run_deploy"},
			"trg_no":   {Reason: untrusted},
			"trg_last": {Accepted: true, RunID: "run_last"},
		},
		errs: map[string]error{
			"trg_err":  errors.New("trigger: github /repos/acme/app/branches/main: 502"),
			"trg_perm": trigger.Permanent(errors.New("trigger: github /repos/acme/app/compare/main...abc: 422")),
		},
	}
	h := newHarnessWith(t, &fakeSource{Head: map[string]string{ConfigFile: unitOnly}}, &fakeRunner{}, "https://hub.invalid", deploys)

	ok := h.deployTrigger("trg_ok", "prod")
	h.send(ok)
	h.send(ok) // resent while queued or being decided
	h.send(h.deployTrigger("trg_no", "prod"))
	h.send(h.deployTrigger("trg_err", "prod"))
	h.send(h.deployTrigger("trg_perm", "prod"))
	h.send(h.trigger("trg_ci", false)) // no env: the checks path
	h.waitTrigger("trg_ok", store.TriggerDone)
	h.waitTrigger("trg_no", store.TriggerRejected)
	h.waitTrigger("trg_err", store.TriggerRejected)
	h.waitTrigger("trg_perm", store.TriggerRejected)
	h.waitTrigger("trg_ci", store.TriggerDone)

	h.send(ok) // resent after it was answered
	h.send(h.deployTrigger("trg_last", "prod"))
	h.waitTrigger("trg_last", store.TriggerDone)

	// A transient failure is retried until the attempts run out; a
	// permanent one is not.
	calls := map[string]int{}
	for _, id := range deploys.called() {
		calls[id]++
	}
	if want := map[string]int{"trg_ok": 1, "trg_no": 1, "trg_err": deployAttempts, "trg_perm": 1, "trg_last": 1}; !maps.Equal(calls, want) {
		t.Errorf("intake calls = %v, want %v", calls, want)
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
		"trg_no":   untrusted,
		"trg_err":  "deployments.prod: github check failed: trigger: github /repos/acme/app/branches/main: 502",
		"trg_perm": "deployments.prod: github check failed: trigger: github /repos/acme/app/compare/main...abc: 422",
	}
	if !maps.Equal(rejected, want) {
		t.Errorf("rejected frames = %v, want %v", rejected, want)
	}
	// Only the checks trigger checked out and ran.
	if len(h.execs) != 1 || h.runCount() != 1 {
		t.Errorf("executions = %v, runs = %d; want only trg_ci", h.execs, h.runCount())
	}
}

// setDeployRetryBase sets the first deploy retry wait for t. Call it before
// the daemon starts, so the old wait is restored only after it stopped.
func setDeployRetryBase(t *testing.T, wait time.Duration) {
	old := deployRetryBase
	deployRetryBase = wait
	t.Cleanup(func() { deployRetryBase = old })
}

func TestDeployRetryWait(t *testing.T) {
	var got []time.Duration
	for failed := 1; failed < deployAttempts+1; failed++ {
		got = append(got, deployRetryWait(failed))
	}
	if want := []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second}; !slices.Equal(got, want) {
		t.Errorf("waits = %v, want %v", got, want)
	}
}

// TestDaemonDeployRetryKeepsWorkerFree: a trigger waiting to retry its
// checks does not hold up triggers for other envs, and a resend of it
// meanwhile is ignored.
func TestDaemonDeployRetryKeepsWorkerFree(t *testing.T) {
	setDeployRetryBase(t, time.Hour)
	deploys := &fakeDeploys{
		decisions: map[string]trigger.Decision{
			"trg_staging": {Accepted: true, RunID: "run_staging"},
			"trg_dev":     {Accepted: true, RunID: "run_dev"},
		},
		errs: map[string]error{"trg_prod": errors.New("trigger: github /repos/acme/app/branches/main: 502")},
	}
	h := newHarnessWith(t, &fakeSource{}, &fakeRunner{}, "https://hub.invalid", deploys)

	prod := h.deployTrigger("trg_prod", "prod")
	h.send(prod)
	h.send(h.deployTrigger("trg_staging", "staging"))
	h.waitTrigger("trg_staging", store.TriggerDone)
	h.send(prod)
	h.send(h.deployTrigger("trg_dev", "dev"))
	h.waitTrigger("trg_dev", store.TriggerDone)

	if got, want := deploys.called(), []string{"trg_prod", "trg_staging", "trg_dev"}; !slices.Equal(got, want) {
		t.Errorf("intake calls = %v, want %v", got, want)
	}
	if rejected := h.frames("rejected"); len(rejected) != 0 {
		t.Errorf("rejected frames = %v, want trg_prod still waiting to retry", rejected)
	}
}

// gitHubHarness is a harness whose deploy triggers go through the default
// intake against a fake GitHub for a push of headSHA to the protected main
// of acme/app. The branch lookup answers 502 to its first fails calls, or
// to every call when fails is negative; branchCalls counts the lookups.
func gitHubHarness(t *testing.T, fails int) (h *harness, branchCalls func() int) {
	t.Helper()
	const cfg = "version: 1\ndeployments:\n  prod:\n    on: { push: main }\n    strategy: script\n    run: ./deploy.sh\n"
	var mu sync.Mutex
	calls := 0
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/acme/app/contents/.zeroci.yml":
			_, _ = w.Write([]byte(cfg))
		case "/repos/acme/app/branches/main":
			mu.Lock()
			calls++
			fail := fails < 0 || calls <= fails
			mu.Unlock()
			if fail {
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			_, _ = w.Write([]byte(`{"protected":true}`))
		case "/repos/acme/app/compare/main..." + headSHA:
			_, _ = w.Write([]byte(`{"status":"identical"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(gh.Close)
	h = newHarnessWith(t, &fakeSource{}, &fakeRunner{}, "https://hub.invalid", nil)
	in := h.d.deploys.(*hubIntake)
	in.githubURL, in.http = gh.URL, gh.Client()
	in.tokens = func(context.Context, string) (string, error) { return "ghs_fetch", nil }
	return h, func() int {
		mu.Lock()
		defer mu.Unlock()
		return calls
	}
}

// TestDaemonDeployCheckRetriesGitHubOutage: GitHub failing twice and then
// answering gets the trigger accepted on the third attempt.
func TestDaemonDeployCheckRetriesGitHubOutage(t *testing.T) {
	setDeployRetryBase(t, time.Millisecond)
	h, branchCalls := gitHubHarness(t, 2)
	h.send(h.deployTrigger("trg_dep", "prod"))
	h.waitTrigger("trg_dep", store.TriggerDone)
	if n := branchCalls(); n != 3 {
		t.Errorf("branch lookups = %d, want 3", n)
	}
	if accepted := h.frames("accepted"); len(accepted) != 1 || accepted[0]["trigger_id"] != "trg_dep" || accepted[0]["run_id"] == nil {
		t.Errorf("accepted frames = %v, want trg_dep once with its run", accepted)
	}
	if rejected := h.frames("rejected"); len(rejected) != 0 {
		t.Errorf("rejected frames = %v, want none", rejected)
	}
}

// TestDaemonDeployCheckGivesUpOnGitHubOutage: GitHub failing every attempt
// rejects the trigger after the last one, with its error.
func TestDaemonDeployCheckGivesUpOnGitHubOutage(t *testing.T) {
	setDeployRetryBase(t, time.Millisecond)
	h, branchCalls := gitHubHarness(t, -1)
	h.send(h.deployTrigger("trg_dep", "prod"))
	h.waitTrigger("trg_dep", store.TriggerRejected)
	if n := branchCalls(); n != deployAttempts {
		t.Errorf("branch lookups = %d, want %d", n, deployAttempts)
	}
	const want = "deployments.prod: github check failed: trigger: github /repos/acme/app/branches/main: 502"
	if rejected := h.frames("rejected"); len(rejected) != 1 || rejected[0]["reason"] != want {
		t.Errorf("rejected frames = %v, want one with %q", rejected, want)
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

// refusingHub is one hub session: it welcomes the agent, sends it a deploy
// trigger and answers every token_request with the auth_failed error frame
// the hub sends for a trigger it no longer holds open.
type refusingHub struct {
	t       *testing.T
	trigger []byte
	in      chan []byte
	closed  chan struct{}
	once    sync.Once
	mu      sync.Mutex
	asked   []string
	reasons []string
}

func (h *refusingHub) Dial(context.Context, string, http.Header) (hubclient.Conn, error) {
	return h, nil
}

func (h *refusingHub) Read(ctx context.Context) ([]byte, error) {
	select {
	case b := <-h.in:
		return b, nil
	case <-h.closed:
		return nil, errors.New("closed")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (h *refusingHub) Write(_ context.Context, b []byte) error {
	if string(b) == "ping" {
		return nil
	}
	var f struct {
		Type   string `json:"type"`
		RunID  string `json:"run_id"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		h.t.Errorf("agent wrote %q: %v", b, err)
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	switch f.Type {
	case "hello":
		h.in <- []byte(`{"v":1,"type":"welcome","hub_version":"test","protocol_min":1,"protocol_max":1,"agent_id":"agt_1","installation_id":42}`)
		h.in <- h.trigger
	case "token_request":
		h.asked = append(h.asked, f.RunID)
		h.in <- []byte(`{"v":1,"type":"error","seq":2,"run_id":"` + f.RunID + `","code":"auth_failed","message":"run not bound"}`)
	case "rejected":
		h.reasons = append(h.reasons, f.Reason)
	}
	return nil
}

func (h *refusingHub) Close(int, string) error {
	h.once.Do(func() { close(h.closed) })
	return nil
}

func (h *refusingHub) state() (asked, reasons []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.asked), slices.Clone(h.reasons)
}

// TestDaemonRefusedTriggerTokenRejects: the hub refusing the token of a
// deploy trigger's checks rejects the trigger at once, without retrying,
// and keeps the daemon serving; it is not taken as a revoked credential.
func TestDaemonRefusedTriggerTokenRejects(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("GitHub called without a token: %s", r.URL.Path)
		http.NotFound(w, r)
	}))
	t.Cleanup(gh.Close)
	stateDir := t.TempDir()
	st, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	env, seq := "prod", 1
	frame, err := protocol.Marshal("trigger", protocol.Trigger{
		Attempt: 1, Env: &env, Event: protocol.TriggerEventPush, Ref: "refs/heads/main", Repo: "acme/app",
		Sha: headSHA, TriggerId: "trg_dep", Trust: protocol.TriggerTrustTrusted, Seq: &seq, HubSeq: seq,
	})
	if err != nil {
		t.Fatal(err)
	}
	hub := &refusingHub{t: t, trigger: frame, in: make(chan []byte, 16), closed: make(chan struct{})}
	d := New(&agentconf.AgentConfig{HubURL: "https://hub.invalid", AgentID: "agt_1", Credential: "zc_agent_x"}, st, nil,
		Options{StateDir: stateDir, Dialer: hub, Source: &fakeSource{}, DeployRunner: noDeployUnits()})
	intake := d.deploys.(*hubIntake)
	intake.githubURL, intake.http = gh.URL, gh.Client()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- d.Run(ctx) }()

	var asked, reasons []string
	for deadline := time.Now().Add(10 * time.Second); len(reasons) == 0; time.Sleep(5 * time.Millisecond) {
		select {
		case err := <-done:
			t.Fatalf("Run = %v before the trigger was answered", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("trigger never rejected")
		}
		asked, reasons = hub.state()
	}
	if !slices.Equal(asked, []string{"trg_dep"}) {
		t.Errorf("token requests = %v, want one for trg_dep", asked)
	}
	const prefix = "deployments.prod: github check failed: "
	if r := reasons[0]; len(reasons) != 1 || !strings.HasPrefix(r, prefix) || strings.Contains(r, "redeliver") ||
		!strings.Contains(r, "hubtokens: hub refused a token for trg_dep: run not bound") {
		t.Errorf("rejected reasons = %q, want one github check failure naming the refusal", reasons)
	}
	if !d.client.Connected() {
		t.Error("session closed after the refusal, want it kept")
	}
	cancel()
	if err := <-done; err != context.Canceled {
		t.Errorf("Run = %v, want context.Canceled, not ErrRevoked", err)
	}
}

// noDeployUnits is a DeployRunner for a host with no leftover deploy units.
func noDeployUnits() *execx.Fake {
	f := &execx.Fake{}
	f.On("systemctl", []string{"list-units"}, execx.FakeResponse{})
	return f
}

// TestDaemonRunInterruptsDeploys: a deploy run an earlier agent left
// Running is stopped and marked Interrupted before the session starts, and
// is not queued again.
func TestDaemonRunInterruptsDeploys(t *testing.T) {
	stateDir := t.TempDir()
	st, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := st.InsertDeployRun(ctx, store.DeployRun{
		RunID: "run_dep", Repo: "acme/app", Env: "prod", SHA: headSHA, Ref: "refs/heads/main",
		Strategy: "compose-bluegreen", State: store.DeployRunning, CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.BeginStep(ctx, "run_dep", 0, "build", nil, time.Now()); err != nil {
		t.Fatal(err)
	}
	units := &execx.Fake{}
	units.On("systemctl", []string{"list-units"}, execx.FakeResponse{Stdout: "zeroci-run-run_dep-deploy.service loaded active running deploy\n"})
	units.On("systemctl", []string{"stop"}, execx.FakeResponse{})

	dialer := &idleDialer{dialed: make(chan struct{})}
	d := New(&agentconf.AgentConfig{HubURL: "https://hub.invalid", AgentID: "agt_1", Credential: "zc_agent_x"}, st, nil,
		Options{StateDir: stateDir, Dialer: dialer, Source: &fakeSource{}, DeployRunner: units})
	done := make(chan error, 1)
	go func() { done <- d.Run(ctx) }()
	select {
	case <-dialer.dialed:
	case err := <-done:
		t.Fatalf("Run = %v before dialing", err)
	}
	run, err := st.GetDeployRun(ctx, "run_dep")
	if err != nil {
		t.Fatal(err)
	}
	const want = "agent restarted during step 1 build; run zeroci retry run_dep"
	if run.State != store.DeployInterrupted || run.Error != want {
		t.Errorf("run = %s %q, want Interrupted %q", run.State, run.Error, want)
	}
	if !units.Called("systemctl", "stop", "zeroci-run-run_dep-deploy") {
		t.Errorf("commands = %+v, want the leftover deploy unit stopped", units.Calls)
	}
	cancel()
	if err := <-done; err != context.Canceled {
		t.Errorf("Run = %v, want context.Canceled", err)
	}
	if run, _ := st.GetDeployRun(context.Background(), "run_dep"); run.State != store.DeployInterrupted || run.Attempt != 1 {
		t.Errorf("run = %s attempt %d after Run, want still Interrupted at attempt 1", run.State, run.Attempt)
	}
}
