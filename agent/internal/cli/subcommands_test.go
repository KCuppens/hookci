package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunNoChecks(t *testing.T) {
	emptyDir := t.TempDir()
	var stdout, stderr bytes.Buffer

	code := Main(context.Background(), []string{"run", emptyDir}, &stdout, &stderr)
	if code != ExitNoChecks {
		t.Fatalf("expected ExitNoChecks (%d), got %d (stderr: %s)", ExitNoChecks, code, stderr.String())
	}
}

func TestRunAndInspectStatusAndLogs(t *testing.T) {
	ctx := context.Background()
	workDir := t.TempDir()
	stateDir := filepath.Join(t.TempDir(), "state")

	// Create .zeroci.yml
	cfgContent := `version: 1
checks:
  lint:
    run: echo "linting code"
  unit:
    needs: [lint]
    run: echo "testing unit"
`
	if err := os.WriteFile(filepath.Join(workDir, ".zeroci.yml"), []byte(cfgContent), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// 1. Execute run
	var stdout, stderr bytes.Buffer
	code := Main(ctx, []string{"run", "-s", stateDir, "--unisolated", workDir}, &stdout, &stderr)
	if code != ExitOK {
		t.Fatalf("run failed with code %d: stderr=%s stdout=%s", code, stderr.String(), stdout.String())
	}

	runOut := stdout.String()
	if !strings.Contains(runOut, "Queued -> Running") {
		t.Errorf("expected transition in output, got: %s", runOut)
	}

	// 2. Check status list
	stdout.Reset()
	stderr.Reset()
	code = Main(ctx, []string{"status", "-s", stateDir}, &stdout, &stderr)
	if code != ExitOK {
		t.Fatalf("status list failed with code %d: %s", code, stderr.String())
	}
	statusListOut := stdout.String()
	if !strings.Contains(statusListOut, "Success") {
		t.Errorf("expected status list to show Success, got: %s", statusListOut)
	}

	// Extract run ID from status list
	lines := strings.Split(strings.TrimSpace(statusListOut), "\n")
	if len(lines) < 2 {
		t.Fatalf("expected at least 2 lines in status list, got: %s", statusListOut)
	}
	fields := strings.Fields(lines[1])
	runID := fields[0]

	// 3. Check status for specific run
	stdout.Reset()
	stderr.Reset()
	code = Main(ctx, []string{"status", "-s", stateDir, runID}, &stdout, &stderr)
	if code != ExitOK {
		t.Fatalf("status run failed with code %d: %s", code, stderr.String())
	}
	statusRunOut := stdout.String()
	if !strings.Contains(statusRunOut, "lint") || !strings.Contains(statusRunOut, "unit") {
		t.Errorf("expected jobs lint and unit in status output, got: %s", statusRunOut)
	}

	// 4. View logs for specific job
	stdout.Reset()
	stderr.Reset()
	code = Main(ctx, []string{"logs", "-s", stateDir, runID, "lint"}, &stdout, &stderr)
	if code != ExitOK {
		t.Fatalf("logs failed with code %d: %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "linting code") {
		t.Errorf("expected 'linting code' in lint log, got: %s", stdout.String())
	}

	// 5. View all logs for run
	stdout.Reset()
	stderr.Reset()
	code = Main(ctx, []string{"logs", "-s", stateDir, runID}, &stdout, &stderr)
	if code != ExitOK {
		t.Fatalf("logs all failed with code %d: %s", code, stderr.String())
	}
	allLogs := stdout.String()
	if !strings.Contains(allLogs, "linting code") || !strings.Contains(allLogs, "testing unit") {
		t.Errorf("expected both job logs in output, got: %s", allLogs)
	}
}

func TestRunFailingJob(t *testing.T) {
	ctx := context.Background()
	workDir := t.TempDir()
	stateDir := filepath.Join(t.TempDir(), "state")

	cfgContent := `version: 1
checks:
  broken:
    run: "false"
`
	if err := os.WriteFile(filepath.Join(workDir, ".zeroci.yml"), []byte(cfgContent), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	var stdout, stderr bytes.Buffer
	code := Main(ctx, []string{"run", "-s", stateDir, "--unisolated", workDir}, &stdout, &stderr)
	if code != ExitRunFailed {
		t.Fatalf("expected ExitRunFailed (%d), got %d (stderr: %s)", ExitRunFailed, code, stderr.String())
	}
}
