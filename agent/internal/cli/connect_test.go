package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"

	"github.com/KCuppens/zerocideploy/agent/internal/agentconf"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
	"github.com/KCuppens/zerocideploy/agent/internal/systemd"
	"github.com/KCuppens/zerocideploy/agent/internal/version"
)

const (
	testPairToken  = "zc_pair_tokentokentoken"
	testCredential = "zc_agent_credcredcredcred"
)

// fakePairHub serves /v1/info, /v1/pair/redeem with status and body, and
// completes a hello/welcome handshake on /v1/agent/connect.
type fakePairHub struct {
	srv     *httptest.Server
	redeems atomic.Int32
	req     atomic.Pointer[redeemRequest]
	auth    atomic.Pointer[string]
	hello   atomic.Pointer[map[string]any]
	// welcome replaces the default welcome frame when set.
	welcome atomic.Pointer[string]
	// info replaces the default /v1/info body when set.
	info atomic.Pointer[string]
}

func newFakePairHub(t *testing.T, status int, body string) *fakePairHub {
	t.Helper()
	h := &fakePairHub{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/info", func(w http.ResponseWriter, r *http.Request) {
		info := fmt.Sprintf(`{"name":"zeroci-hub","version":"test","mode":"shared","protocol_versions":[%d,%d],"github_app":{"slug":"zeroci"},"slack":{"enabled":true}}`, protocol.Version, protocol.Version)
		if i := h.info.Load(); i != nil {
			info = *i
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(info))
	})
	mux.HandleFunc("POST /v1/pair/redeem", func(w http.ResponseWriter, r *http.Request) {
		h.redeems.Add(1)
		var req redeemRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
			h.req.Store(&req)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
	mux.HandleFunc("GET /v1/agent/connect", func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		h.auth.Store(&auth)
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		_, b, err := c.Read(ctx)
		if err != nil {
			return
		}
		var hello map[string]any
		if json.Unmarshal(b, &hello) == nil {
			h.hello.Store(&hello)
		}
		welcome := `{"v":1,"type":"welcome","hub_version":"test","protocol_min":1,"protocol_max":1,"agent_id":"agt_1","installation_id":42}`
		if w := h.welcome.Load(); w != nil {
			welcome = *w
		}
		if err := c.Write(ctx, websocket.MessageText, []byte(welcome)); err != nil {
			return
		}
		for {
			if _, _, err := c.Read(ctx); err != nil {
				return
			}
		}
	})
	h.srv = httptest.NewServer(mux)
	t.Cleanup(h.srv.Close)
	return h
}

const redeemOK = `{"agent_id":"agt_1","credential":"` + testCredential + `","installation_id":42,"hub_ws_url":"wss://hub/v1/agent/connect","name":"build-1"}`

// fakeServices is a ServiceManager where only the units in exist are
// installed and every unit is in state, "inactive" when empty.
type fakeServices struct {
	exist     map[string]bool
	state     string
	enabled   []string
	restarted []string
}

func (f *fakeServices) UnitExists(_ context.Context, unit string) (bool, error) {
	return f.exist[unit], nil
}

func (f *fakeServices) EnableNow(_ context.Context, unit string) error {
	f.enabled = append(f.enabled, unit)
	return nil
}

func (f *fakeServices) TryRestart(_ context.Context, unit string) error {
	f.restarted = append(f.restarted, unit)
	return nil
}

func (f *fakeServices) ActiveState(context.Context, string) (string, error) {
	if f.state == "" {
		return "inactive", nil
	}
	return f.state, nil
}

// runConnectCLI runs zeroci with svc in place of systemctl.
func runConnectCLI(svc systemd.ServiceManager, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := MainWithDeps(args, &stdout, &stderr, func(g Globals, w io.Writer) Deps {
		d := DefaultDeps(g, w)
		d.Services = svc
		return d
	})
	return code, stdout.String(), stderr.String()
}

func TestConnectWritesConfig(t *testing.T) {
	hub := newFakePairHub(t, http.StatusOK, redeemOK)
	dir := filepath.Join(t.TempDir(), "state")

	svc := &fakeServices{exist: map[string]bool{"zeroci-agent@42.service": true}}
	code, stdout, stderr := runConnectCLI(svc, "connect", testPairToken, "--hub", hub.srv.URL, "--name", "build-1", "--state-dir", dir)
	if code != ExitOK {
		t.Fatalf("exit = %d, want 0; stderr:\n%s", code, stderr)
	}

	path := filepath.Join(dir, agentconf.FileName)
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("agent.json mode = %04o, want 0600", perm)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"agent_id": "agt_1"`, `"credential": "` + testCredential + `"`, `"installation_id": 42`, `"hub_url": "` + hub.srv.URL + `"`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("agent.json lacks %s:\n%s", want, raw)
		}
	}
	if di, err := os.Stat(dir); err != nil || di.Mode().Perm() != 0o700 {
		t.Errorf("state dir mode = %v, %v; want 0700", di.Mode().Perm(), err)
	}

	for _, secret := range []string{testCredential, testPairToken} {
		if strings.Contains(stdout, secret) || strings.Contains(stderr, secret) {
			t.Errorf("output contains secret %q\nstdout:\n%s\nstderr:\n%s", secret, stdout, stderr)
		}
	}
	wantOut := "Connected to " + hub.srv.URL + " as build-1 (agent agt_1)\nStarted zeroci-agent@42.service\n"
	if len(svc.enabled) != 1 || svc.enabled[0] != "zeroci-agent@42.service" {
		t.Errorf("enabled units = %v, want zeroci-agent@42.service", svc.enabled)
	}
	if stdout != wantOut {
		t.Errorf("stdout = %q, want %q", stdout, wantOut)
	}

	req := hub.req.Load()
	if req == nil {
		t.Fatal("hub never received a redeem request")
	}
	if req.PairToken != testPairToken || req.Name != "build-1" || req.OS != runtime.GOOS || req.Arch != runtime.GOARCH || req.AgentVersion == "" || req.Hostname == "" {
		t.Errorf("redeem request = %+v", *req)
	}
	if auth := hub.auth.Load(); auth == nil || *auth != "Bearer "+testCredential {
		t.Errorf("handshake Authorization = %v, want the redeemed credential", auth)
	}
	if hello := hub.hello.Load(); hello == nil || (*hello)["type"] != "hello" || (*hello)["agent_id"] != "agt_1" {
		t.Errorf("first frame = %v, want hello for agt_1", hello)
	}
}

func TestConnectServiceSkipped(t *testing.T) {
	tests := []struct {
		name  string
		exist bool
		flags []string
		want  string
	}{
		{"no-service flag", true, []string{"--no-service"}, "Next: sudo systemctl enable --now zeroci-agent@42.service\n"},
		{"unit not installed", false, nil, "No zeroci-agent@42.service unit"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			hub := newFakePairHub(t, http.StatusOK, redeemOK)
			svc := &fakeServices{exist: map[string]bool{"zeroci-agent@42.service": tc.exist}}
			args := append([]string{"connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", t.TempDir()}, tc.flags...)
			code, stdout, stderr := runConnectCLI(svc, args...)
			if code != ExitOK {
				t.Fatalf("exit = %d; stderr:\n%s", code, stderr)
			}
			if len(svc.enabled) != 0 {
				t.Errorf("enabled %v, want nothing", svc.enabled)
			}
			if !strings.Contains(stdout, tc.want) {
				t.Errorf("stdout = %q, want %q", stdout, tc.want)
			}
		})
	}
}

func TestConnectInvalidToken(t *testing.T) {
	hub := newFakePairHub(t, http.StatusBadRequest, `{"error":"invalid_pair_token"}`)
	dir := filepath.Join(t.TempDir(), "state")

	code, stdout, stderr := runConnectCLI(&fakeServices{}, "connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", dir)
	if code == ExitOK {
		t.Fatal("exit = 0, want non-zero")
	}
	if !strings.Contains(stderr, "pair token invalid, expired or already used: create a new one in Slack App Home") {
		t.Errorf("stderr = %q, want the documented message", stderr)
	}
	if strings.Contains(stdout+stderr, testPairToken) {
		t.Error("output contains the pair token")
	}
	if _, err := os.Stat(filepath.Join(dir, agentconf.FileName)); !os.IsNotExist(err) {
		t.Errorf("agent.json written after a failed redeem (stat err %v)", err)
	}
}

func TestConnectRedeemErrors(t *testing.T) {
	tests := []struct {
		status int
		body   string
		want   string
	}{
		{http.StatusConflict, `{"error":"agent_limit"}`, "this installation already has 10 agents"},
		{http.StatusTooManyRequests, `{"error":"rate_limited"}`, "too many attempts, try again later"},
	}
	for _, tc := range tests {
		hub := newFakePairHub(t, tc.status, tc.body)
		code, _, stderr := runConnectCLI(&fakeServices{}, "connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", t.TempDir())
		if code == ExitOK || !strings.Contains(stderr, tc.want) {
			t.Errorf("HTTP %d: exit = %d stderr = %q, want non-zero and %q", tc.status, code, stderr, tc.want)
		}
	}
}

func TestConnectRefusesExistingAgent(t *testing.T) {
	hub := newFakePairHub(t, http.StatusOK, redeemOK)
	dir := t.TempDir()
	if err := agentconf.Save(dir, &agentconf.AgentConfig{AgentID: "agt_old", Credential: "zc_agent_old", Name: "old"}); err != nil {
		t.Fatal(err)
	}

	code, _, stderr := runConnectCLI(&fakeServices{}, "connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", dir)
	if code == ExitOK || !strings.Contains(stderr, "agt_old") || !strings.Contains(stderr, "--force") {
		t.Fatalf("exit = %d stderr = %q, want a refusal naming agt_old and --force", code, stderr)
	}
	if n := hub.redeems.Load(); n != 0 {
		t.Fatalf("redeemed the pair token %d times before refusing", n)
	}

	code, _, stderr = runConnectCLI(&fakeServices{}, "connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", dir, "--force")
	if code != ExitOK {
		t.Fatalf("with --force exit = %d; stderr:\n%s", code, stderr)
	}
	cfg, err := agentconf.Load(dir)
	if err != nil || cfg.AgentID != "agt_1" {
		t.Fatalf("after --force agent.json = %+v, %v; want agt_1", cfg, err)
	}
}

// A re-paired agent's running unit still serves the replaced agent until it
// restarts; enable --now alone leaves it running.
func TestConnectForceRestartsRunningAgent(t *testing.T) {
	hub := newFakePairHub(t, http.StatusOK, redeemOK)
	dir := t.TempDir()
	if err := agentconf.Save(dir, &agentconf.AgentConfig{AgentID: "agt_old", Credential: "zc_agent_old", Name: "old"}); err != nil {
		t.Fatal(err)
	}
	unit := "zeroci-agent@42.service"
	svc := &fakeServices{exist: map[string]bool{unit: true}, state: "active"}
	code, stdout, stderr := runConnectCLI(svc, "connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", dir, "--force")
	if code != ExitOK {
		t.Fatalf("exit = %d; stderr:\n%s", code, stderr)
	}
	if len(svc.restarted) != 1 || svc.restarted[0] != unit {
		t.Errorf("restarted units = %v, want %s", svc.restarted, unit)
	}
	if !strings.HasSuffix(stdout, "Restarted "+unit+"\n") {
		t.Errorf("stdout = %q, want it to end with Restarted %s", stdout, unit)
	}

	svc = &fakeServices{exist: map[string]bool{unit: true}}
	code, stdout, stderr = runConnectCLI(svc, "connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", dir, "--force", "--no-service")
	if code != ExitOK || !strings.Contains(stdout, "sudo systemctl restart "+unit) {
		t.Errorf("--no-service exit = %d stdout = %q stderr = %q, want a restart hint", code, stdout, stderr)
	}
}

// connect --force must not claim the replaced agent's hub frames for the new
// agent: its hub has never sent them, and the running agent owns agent.db.
func TestConnectForceClaimsNoHubFrames(t *testing.T) {
	hub := newFakePairHub(t, http.StatusOK, redeemOK)
	dir := t.TempDir()
	if err := agentconf.Save(dir, &agentconf.AgentConfig{AgentID: "agt_old", Credential: "zc_agent_old", Name: "old"}); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetHWM(context.Background(), store.HWMIn, 7); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	code, _, stderr := runConnectCLI(&fakeServices{}, "connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", dir, "--force")
	if code != ExitOK {
		t.Fatalf("exit = %d; stderr:\n%s", code, stderr)
	}
	hello := hub.hello.Load()
	if hello == nil || (*hello)["inbound_hwm"] != float64(0) {
		t.Fatalf("hello = %v, want inbound_hwm 0", hello)
	}
}

// The hub compares agent_version to its minimum as a bare semantic version.
func TestConnectSendsBareVersion(t *testing.T) {
	oldV, oldC := version.Version, version.Commit
	version.Version, version.Commit = "1.2.3", "abcdef0"
	t.Cleanup(func() { version.Version, version.Commit = oldV, oldC })
	hub := newFakePairHub(t, http.StatusOK, redeemOK)
	code, _, stderr := runConnectCLI(&fakeServices{}, "connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", t.TempDir())
	if code != ExitOK {
		t.Fatalf("exit = %d; stderr:\n%s", code, stderr)
	}
	if req := hub.req.Load(); req == nil || req.AgentVersion != "1.2.3" {
		t.Errorf("redeem request = %+v, want agent_version 1.2.3", req)
	}
	if hello := hub.hello.Load(); hello == nil || (*hello)["agent_version"] != "1.2.3" {
		t.Errorf("hello = %v, want agent_version 1.2.3", hello)
	}
}

func TestConnectUsage(t *testing.T) {
	for _, args := range [][]string{{"connect"}, {"connect", "a", "b"}, {"connect", "--bogus", "x"}} {
		if code, _, _ := runConnectCLI(&fakeServices{}, args...); code != ExitUsage {
			t.Errorf("%v: exit = %d, want %d", args, code, ExitUsage)
		}
	}
}

func TestResolveHubURL(t *testing.T) {
	tests := []struct {
		name, flag, env, want, err string
	}{
		{name: "flag beats env", flag: "https://flag.example", env: "https://env.example", want: "https://flag.example"},
		{name: "env beats default", env: "https://env.example/", want: "https://env.example"},
		{name: "default", want: defaultHubURL},
		{name: "trailing slash stripped", flag: "https://hub.example/ci/", want: "https://hub.example/ci"},
		{name: "plain http rejected", flag: "http://example.com", err: "must use https"},
		{name: "plain http in env rejected", env: "http://example.com", err: "must use https"},
		{name: "localhost http", flag: "http://localhost:8787", want: "http://localhost:8787"},
		{name: "loopback v4 http", flag: "http://127.0.0.1:8787/", want: "http://127.0.0.1:8787"},
		{name: "loopback v6 http", flag: "http://[::1]:8787", want: "http://[::1]:8787"},
		{name: "lookalike host rejected", flag: "http://localhost.example.com", err: "must use https"},
		{name: "websocket scheme rejected", flag: "wss://hub.example", err: "must use https"},
		{name: "relative rejected", flag: "hub.example", err: "not an absolute URL"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveHubURL(tc.flag, tc.env)
			if tc.err != "" {
				if err == nil || !strings.Contains(err.Error(), tc.err) {
					t.Fatalf("resolveHubURL(%q, %q) = %q, %v; want error containing %q", tc.flag, tc.env, got, err, tc.err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("resolveHubURL(%q, %q) = %q, %v; want %q", tc.flag, tc.env, got, err, tc.want)
			}
		})
	}
}

func TestConnectRejectsPlainHTTPHub(t *testing.T) {
	code, _, stderr := runConnectCLI(&fakeServices{}, "connect", testPairToken, "--hub", "http://example.com", "--state-dir", t.TempDir())
	if code != ExitUsage || !strings.Contains(stderr, "must use https") {
		t.Fatalf("exit = %d stderr = %q, want usage error about https", code, stderr)
	}
}

func TestCompatible(t *testing.T) {
	tests := []struct {
		hub                []int
		agentMin, agentMax int
		want               bool
	}{
		{[]int{1, 1}, 1, 1, true},
		{[]int{1, 2}, 2, 2, true},
		{[]int{2, 3}, 1, 2, true},
		{[]int{2, 3}, 1, 1, false},
		{[]int{1, 1}, 2, 3, false},
		{nil, 1, 1, false},
	}
	for _, tc := range tests {
		if got := compatible(tc.hub, tc.agentMin, tc.agentMax); got != tc.want {
			t.Errorf("compatible(%v, %d, %d) = %v, want %v", tc.hub, tc.agentMin, tc.agentMax, got, tc.want)
		}
	}
}

// A hub that cannot speak this agent's protocol must not consume the
// single-use pair token.
func TestConnectProtocolMismatchSkipsRedeem(t *testing.T) {
	hub := newFakePairHub(t, http.StatusOK, redeemOK)
	info := `{"name":"zeroci-hub","version":"9.0.0","mode":"self_hosted","protocol_versions":[7,8],"github_app":{"slug":"x"},"slack":{"enabled":false}}`
	hub.info.Store(&info)
	dir := t.TempDir()
	code, _, stderr := runConnectCLI(&fakeServices{}, "connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", dir)
	want := fmt.Sprintf("hub speaks protocol versions 7..8, this agent speaks %d; upgrade with `zeroci upgrade`", protocol.Version)
	if code == ExitOK || !strings.Contains(stderr, want) {
		t.Fatalf("exit = %d stderr = %q, want non-zero and %q", code, stderr, want)
	}
	if n := hub.redeems.Load(); n != 0 {
		t.Fatalf("redeemed the pair token %d times despite the protocol mismatch", n)
	}
	if _, err := agentconf.Load(dir); err == nil {
		t.Error("agent.json written despite the protocol mismatch")
	}
}

// agent.json keeps the hub's mode, which decides whether trust: all parses.
func TestConnectStoresHubMode(t *testing.T) {
	for _, mode := range []string{"shared", "self_hosted"} {
		t.Run(mode, func(t *testing.T) {
			hub := newFakePairHub(t, http.StatusOK, redeemOK)
			info := fmt.Sprintf(`{"name":"zeroci-hub","version":"test","mode":%q,"protocol_versions":[%d,%d],"github_app":{"slug":"zeroci"},"slack":{"enabled":true}}`, mode, protocol.Version, protocol.Version)
			hub.info.Store(&info)
			dir := t.TempDir()
			if code, _, stderr := runConnectCLI(&fakeServices{}, "connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", dir, "--no-service"); code != ExitOK {
				t.Fatalf("exit = %d stderr = %q", code, stderr)
			}
			cfg, err := agentconf.Load(dir)
			if err != nil || cfg.HubMode != mode {
				t.Fatalf("agent.json = %+v, %v; want hub_mode %s", cfg, err, mode)
			}
		})
	}
}

func TestConnectRefusesNonHub(t *testing.T) {
	hub := newFakePairHub(t, http.StatusOK, redeemOK)
	info := `{"name":"something-else"}`
	hub.info.Store(&info)
	code, _, stderr := runConnectCLI(&fakeServices{}, "connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", t.TempDir())
	if code == ExitOK || !strings.Contains(stderr, "not a zeroci hub") {
		t.Fatalf("exit = %d stderr = %q, want a not-a-hub refusal", code, stderr)
	}
	if n := hub.redeems.Load(); n != 0 {
		t.Fatalf("redeemed the pair token %d times against a non-hub", n)
	}
}

// The hub URL comes from $ZEROCI_HUB_URL without --hub, loses its trailing
// slash, and is stored for the agent's reconnects; --hub still wins over it.
func TestConnectHubURLFromEnvIsStored(t *testing.T) {
	hub := newFakePairHub(t, http.StatusOK, redeemOK)
	t.Setenv("ZEROCI_HUB_URL", hub.srv.URL+"/")
	dir := t.TempDir()
	code, _, stderr := runConnectCLI(&fakeServices{}, "connect", testPairToken, "--state-dir", dir, "--no-service")
	if code != ExitOK {
		t.Fatalf("exit = %d; stderr:\n%s", code, stderr)
	}
	cfg, err := agentconf.Load(dir)
	if err != nil || cfg.HubURL != hub.srv.URL {
		t.Fatalf("agent.json = %+v, %v; want hub_url %s", cfg, err, hub.srv.URL)
	}

	t.Setenv("ZEROCI_HUB_URL", "https://unreachable.invalid")
	dir = t.TempDir()
	code, _, stderr = runConnectCLI(&fakeServices{}, "connect", testPairToken, "--hub", hub.srv.URL, "--state-dir", dir, "--no-service")
	if code != ExitOK {
		t.Fatalf("--hub over env: exit = %d; stderr:\n%s", code, stderr)
	}
	if cfg, err := agentconf.Load(dir); err != nil || cfg.HubURL != hub.srv.URL {
		t.Fatalf("--hub over env: agent.json = %+v, %v; want hub_url %s", cfg, err, hub.srv.URL)
	}
}
