//go:build integration

package deploy

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/testutil"
)

// TestUnitExecutorRunsAsDeployUserIntegration runs `id -un` in a real deploy
// unit and expects the hookci-deploy account.
func TestUnitExecutorRunsAsDeployUserIntegration(t *testing.T) {
	testutil.RequireIntegration(t)
	if _, err := exec.LookPath("systemd-run"); err != nil {
		t.Skip("systemd-run not in PATH")
	}
	testutil.EnsureUser(t, DeployUser)
	u := &UnitExecutor{Runner: execx.OS{}, RunID: "itest" + strings.ReplaceAll(t.Name(), "/", "_"), User: DeployUser}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var out bytes.Buffer
	if err := u.Run(ctx, "whoami", []string{"id", "-un"}, ExecOpts{Stdout: &out, Timeout: 30 * time.Second}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := strings.TrimSpace(out.String()); got != DeployUser {
		t.Errorf("id -un = %q, want %q", got, DeployUser)
	}
}
