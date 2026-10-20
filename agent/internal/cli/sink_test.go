package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/agentconf"
)

const sinkTestToken = "123:abc"

type sinkHub struct {
	mu     sync.Mutex
	bodies []map[string]any
	status int
	answer string
}

func newSinkDeps(t *testing.T, h *sinkHub, stdin string) Deps {
	t.Helper()
	t.Setenv(telegramTokenEnv, "")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testCredential {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		h.mu.Lock()
		h.bodies = append(h.bodies, body)
		h.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(h.status)
		_, _ = io.WriteString(w, h.answer)
	}))
	t.Cleanup(srv.Close)
	d, _ := testDeps(t, t.TempDir())
	if err := os.MkdirAll(d.Globals.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := agentconf.Save(d.Globals.StateDir, &agentconf.AgentConfig{
		HubURL: srv.URL, AgentID: "agt_1", Credential: testCredential, Name: "build-1", InstallationID: 42,
	}); err != nil {
		t.Fatal(err)
	}
	d.Stdin = strings.NewReader(stdin)
	return d
}

func runSink(d Deps, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := cmdSink(context.Background(), d, args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

const sinkJSON = `{"id":"snk_1","kind":"webhook","repo":"o/r","label":null,"target":"https://ex.com/…","created_at":"2026-01-01T00:00:00Z","disabled_at":null,"last_error":null}`

func TestSinkAddTelegramReadsTokenFromStdin(t *testing.T) {
	h := &sinkHub{status: http.StatusCreated, answer: `{"sink":` + strings.Replace(sinkJSON, "webhook", "telegram", 1) + `}`}
	d := newSinkDeps(t, h, sinkTestToken+"\n")
	code, stdout, stderr := runSink(d, "add", "telegram", "--repo", "o/r", "--chat-id", "-100")
	if code != ExitOK {
		t.Fatalf("exit = %d; stderr:\n%s", code, stderr)
	}
	if len(h.bodies) != 1 || h.bodies[0]["bot_token"] != sinkTestToken || h.bodies[0]["chat_id"] != "-100" || h.bodies[0]["kind"] != "telegram" {
		t.Fatalf("bodies = %v", h.bodies)
	}
	if strings.Contains(stderr, sinkTestToken) || strings.Contains(stdout, sinkTestToken) {
		t.Fatalf("token leaked: stdout %q stderr %q", stdout, stderr)
	}
}

func TestSinkAddTelegramHasNoTokenFlag(t *testing.T) {
	h := &sinkHub{status: http.StatusCreated}
	d := newSinkDeps(t, h, "")
	code, _, stderr := runSink(d, "add", "telegram", "--repo", "o/r", "--chat-id", "1", "--token", sinkTestToken)
	if code != ExitUsage {
		t.Fatalf("exit = %d, want %d", code, ExitUsage)
	}
	if len(h.bodies) != 0 {
		t.Fatalf("hub called: %v", h.bodies)
	}
	if strings.Contains(stderr, sinkTestToken) {
		t.Fatalf("token in stderr: %q", stderr)
	}
}

func TestSinkAddWebhookPrintsSecretOnce(t *testing.T) {
	h := &sinkHub{status: http.StatusCreated, answer: `{"sink":` + sinkJSON + `,"generated_secret":"whsec_xyz"}`}
	d := newSinkDeps(t, h, "")
	code, stdout, stderr := runSink(d, "add", "webhook", "--repo", "o/r", "--url", "https://ex.com/hook")
	if code != ExitOK {
		t.Fatalf("exit = %d; stderr:\n%s", code, stderr)
	}
	if n := strings.Count(stdout, "whsec_xyz"); n != 1 {
		t.Fatalf("secret printed %d times:\n%s", n, stdout)
	}
	if strings.Contains(stderr, "whsec_xyz") {
		t.Fatalf("secret in stderr: %q", stderr)
	}
	if h.bodies[0]["url"] != "https://ex.com/hook" {
		t.Fatalf("body = %v", h.bodies[0])
	}
	if _, ok := h.bodies[0]["bot_token"]; ok {
		t.Fatalf("webhook body carries bot_token: %v", h.bodies[0])
	}
}

func TestSinkAddWebhookSecretStdinPrintsOnlySecret(t *testing.T) {
	h := &sinkHub{status: http.StatusCreated, answer: `{"sink":` + sinkJSON + `,"generated_secret":"whsec_xyz"}`}
	d := newSinkDeps(t, h, "")
	code, stdout, stderr := runSink(d, "add", "webhook", "--repo", "o/r", "--url", "https://ex.com/hook", "--secret-stdin")
	if code != ExitOK {
		t.Fatalf("exit = %d; stderr:\n%s", code, stderr)
	}
	if stdout != "whsec_xyz\n" {
		t.Fatalf("stdout = %q, want only the secret line", stdout)
	}
}

func TestSinkListJSON(t *testing.T) {
	h := &sinkHub{status: http.StatusOK, answer: `{"sinks":[` + sinkJSON + `]}`}
	d := newSinkDeps(t, h, "")
	code, stdout, stderr := runSink(d, "ls", "--repo", "o/r", "--json")
	if code != ExitOK {
		t.Fatalf("exit = %d; stderr:\n%s", code, stderr)
	}
	var got []map[string]any
	if err := json.Unmarshal([]byte(stdout), &got); err != nil {
		t.Fatalf("invalid JSON %q: %v", stdout, err)
	}
	if len(got) != 1 || got[0]["id"] != "snk_1" {
		t.Fatalf("got %v", got)
	}
}

func TestSinkListTable(t *testing.T) {
	h := &sinkHub{status: http.StatusOK, answer: `{"sinks":[` + sinkJSON + `]}`}
	d := newSinkDeps(t, h, "")
	code, stdout, _ := runSink(d, "ls", "--repo", "o/r")
	if code != ExitOK || !strings.Contains(stdout, "ID") || !strings.Contains(stdout, "snk_1") || !strings.Contains(stdout, "enabled") {
		t.Fatalf("exit = %d, stdout:\n%s", code, stdout)
	}
}

func TestSinkUnknownSubcommandExits2(t *testing.T) {
	d := newSinkDeps(t, &sinkHub{status: http.StatusOK}, "")
	if code, _, _ := runSink(d, "frobnicate"); code != ExitUsage {
		t.Fatalf("exit = %d, want %d", code, ExitUsage)
	}
	if code, _, _ := runSink(d, "add", "linear"); code != ExitUsage {
		t.Fatalf("add linear exit = %d, want %d", code, ExitUsage)
	}
}

func TestSinkAPIFailureExits1(t *testing.T) {
	h := &sinkHub{status: http.StatusBadRequest, answer: `{"error":"invalid","message":"bad chat id"}`}
	d := newSinkDeps(t, h, sinkTestToken+"\n")
	code, stdout, stderr := runSink(d, "add", "telegram", "--repo", "o/r", "--chat-id", "x")
	if code != ExitRunFailed {
		t.Fatalf("exit = %d, want %d", code, ExitRunFailed)
	}
	if strings.Contains(stderr, sinkTestToken) || strings.Contains(stdout, sinkTestToken) {
		t.Fatalf("token leaked: %q", stderr)
	}
	h.status, h.answer = http.StatusNotFound, `{"error":"not_found","message":"no sink"}`
	if code, _, _ := runSink(d, "rm", "snk_x"); code != ExitRunFailed {
		t.Fatalf("rm exit = %d, want %d", code, ExitRunFailed)
	}
}

func TestSinkRemoveAndTest(t *testing.T) {
	h := &sinkHub{status: http.StatusNoContent}
	d := newSinkDeps(t, h, "")
	if code, stdout, stderr := runSink(d, "rm", "snk_1"); code != ExitOK || !strings.Contains(stdout, "snk_1") {
		t.Fatalf("rm exit = %d stdout %q stderr %q", code, stdout, stderr)
	}
	h.status, h.answer = http.StatusOK, `{"result":"ok"}`
	if code, _, stderr := runSink(d, "test", "snk_1"); code != ExitOK {
		t.Fatalf("test exit = %d stderr %q", code, stderr)
	}
	h.answer = `{"result":"fail","detail":"http_404"}`
	if code, _, _ := runSink(d, "test", "snk_1"); code != ExitRunFailed {
		t.Fatalf("failed test exit = %d, want %d", code, ExitRunFailed)
	}
}
