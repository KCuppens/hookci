package cli

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/agentconf"
)

func TestAgentTooOldExits4(t *testing.T) {
	hub := newFakePairHub(t, http.StatusOK, redeemOK)
	welcome := `{"v":1,"type":"welcome","hub_version":"test","protocol_min":1,"protocol_max":1,"agent_id":"agt_1","installation_id":42,"min_agent_version":"v99.0.0"}`
	hub.welcome.Store(&welcome)
	d, _ := testDeps(t, t.TempDir())
	if err := os.MkdirAll(d.Globals.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := agentconf.Save(d.Globals.StateDir, &agentconf.AgentConfig{
		HubURL: hub.srv.URL, AgentID: "agt_1", Credential: testCredential, Name: "build-1", InstallationID: 42,
	}); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var stdout, stderr bytes.Buffer
	code := cmdAgent(ctx, d, nil, &stdout, &stderr)

	if code != ExitAgentTooOld || ExitAgentTooOld != 4 {
		t.Fatalf("exit = %d, want 4; stderr:\n%s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "zeroci: agent_too_old:") || !strings.Contains(stderr.String(), "zeroci upgrade") {
		t.Fatalf("stderr does not report agent_too_old with an upgrade hint:\n%s", stderr.String())
	}
}

// The unit stops restarting an agent without agent.json (exit 3), but an
// internal error must stay restartable: RestartPreventExitStatus is 3 4.
func TestAgentNotConfiguredExits3(t *testing.T) {
	if ExitInternal == 3 || ExitInternal == 4 {
		t.Fatalf("ExitInternal = %d, which the unit never restarts", ExitInternal)
	}
	d, _ := testDeps(t, t.TempDir())
	d.StateRoot = t.TempDir()
	var stderr bytes.Buffer
	code := cmdAgent(context.Background(), d, []string{"--installation", "7"}, io.Discard, &stderr)
	if code != ExitNotConfigured || ExitNotConfigured != 3 {
		t.Fatalf("exit = %d, want 3; stderr:\n%s", code, stderr.String())
	}
	if want := filepath.Join(d.StateRoot, "7", agentconf.FileName); !strings.Contains(stderr.String(), want) {
		t.Errorf("stderr = %q, want the missing %s", stderr.String(), want)
	}
}

func TestAgentRejectsNegativeInstallation(t *testing.T) {
	d, _ := testDeps(t, t.TempDir())
	var stderr bytes.Buffer
	if code := cmdAgent(context.Background(), d, []string{"--installation", "-1"}, io.Discard, &stderr); code != ExitUsage {
		t.Fatalf("exit = %d, want %d", code, ExitUsage)
	}
	if !strings.Contains(stderr.String(), "--installation must be a positive installation id") {
		t.Errorf("stderr = %q", stderr.String())
	}
}
