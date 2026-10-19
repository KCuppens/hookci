package cli_test

import (
	"bytes"
	"context"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/cli"
)

func TestNodeAppEndToEnd(t *testing.T) {
	ctx := context.Background()

	// Locate examples/node-app relative to repo root
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("failed to get caller path")
	}
	repoRoot := filepath.Join(filepath.Dir(thisFile), "..", "..", "..")
	nodeAppDir := filepath.Join(repoRoot, "examples", "node-app")

	stateDir := filepath.Join(t.TempDir(), "zeroci-state")

	var stdout, stderr bytes.Buffer
	code := cli.Main(ctx, []string{"run", "-s", stateDir, "--unisolated", nodeAppDir}, &stdout, &stderr)
	if code != cli.ExitOK {
		t.Fatalf("expected ExitOK (%d), got %d (stderr: %s, stdout: %s)",
			cli.ExitOK, code, stderr.String(), stdout.String())
	}

	out := stdout.String()
	// Must have detected and run all three npm scripts: lint, typecheck, unit
	for _, expectedJob := range []string{"lint", "typecheck", "unit"} {
		if !strings.Contains(out, expectedJob) {
			t.Errorf("expected job %q in output, got:\n%s", expectedJob, out)
		}
	}

	// Verify status command on state directory
	stdout.Reset()
	stderr.Reset()
	code = cli.Main(ctx, []string{"status", "-s", stateDir}, &stdout, &stderr)
	if code != cli.ExitOK {
		t.Fatalf("status failed: %d (stderr: %s)", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Success") {
		t.Errorf("expected Success in status, got: %s", stdout.String())
	}

	// Parse runID
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(lines) < 2 {
		t.Fatalf("expected at least 2 lines in status, got: %s", stdout.String())
	}
	runID := strings.Fields(lines[1])[0]

	// Verify logs for unit job
	stdout.Reset()
	stderr.Reset()
	code = cli.Main(ctx, []string{"logs", "-s", stateDir, runID, "unit"}, &stdout, &stderr)
	if code != cli.ExitOK {
		t.Fatalf("logs failed: %d (stderr: %s)", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "unit tests passed") {
		t.Errorf("expected 'unit tests passed' in unit logs, got: %s", stdout.String())
	}
}
