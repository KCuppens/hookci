package cli

import (
	"bytes"
	"context"
	"net/http"
	"os"
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

	if code != ExitInternal {
		t.Fatalf("exit = %d, want %d; stderr:\n%s", code, ExitInternal, stderr.String())
	}
	if !strings.Contains(stderr.String(), "zeroci: agent_too_old:") || !strings.Contains(stderr.String(), "zeroci upgrade") {
		t.Fatalf("stderr does not report agent_too_old with an upgrade hint:\n%s", stderr.String())
	}
}
