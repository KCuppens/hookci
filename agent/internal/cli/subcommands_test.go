package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/logpipe"
)

func TestRunNoChecks(t *testing.T) {
	emptyDir := t.TempDir()
	var stdout, stderr bytes.Buffer

	code := Main([]string{"run", emptyDir}, &stdout, &stderr)
	if code != ExitNoChecks {
		t.Fatalf("expected ExitNoChecks (%d), got %d (stderr: %s)", ExitNoChecks, code, stderr.String())
	}
}

func runLogsWithDeadline(t *testing.T, ctx context.Context, args []string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() { done <- dispatch(ctx, args, &stdout, &stderr) }()
	select {
	case code := <-done:
		return code, stdout.String(), stderr.String()
	case <-time.After(5 * time.Second):
		t.Fatalf("zeroci %v hung", args)
		return 0, "", ""
	}
}

func TestLogsFollowMissingLogExits(t *testing.T) {
	stateDir := t.TempDir()
	code, _, stderr := runLogsWithDeadline(t, context.Background(),
		[]string{"logs", "-f", "-s", stateDir, "01j7run", "lint"})
	if code != ExitUsage {
		t.Fatalf("expected ExitUsage (%d), got %d (stderr: %s)", ExitUsage, code, stderr)
	}
	if !strings.Contains(stderr, `log not found for job "lint"`) {
		t.Errorf("unexpected stderr: %s", stderr)
	}
}

func TestLogsFollowStopsOnCancel(t *testing.T) {
	stateDir := t.TempDir()
	logFile := logpipe.LogPath(filepath.Join(stateDir, "runs", "01j7run"), "lint")
	if err := os.MkdirAll(filepath.Dir(logFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logFile, []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	code, stdout, stderr := runLogsWithDeadline(t, ctx,
		[]string{"logs", "-f", "-s", stateDir, "01j7run", "lint"})
	if code != ExitOK {
		t.Fatalf("expected ExitOK, got %d (stderr: %s)", code, stderr)
	}
	if !strings.Contains(stdout, "hello") {
		t.Errorf("stdout = %q, want it to contain hello", stdout)
	}
}

func TestRunRefusesLockedStateDir(t *testing.T) {
	ctx := context.Background()
	workDir := t.TempDir()
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workDir, ".zeroci.yml"), []byte("version: 1\nchecks:\n  jobs:\n    lint:\n      run: echo ok\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	unlock, err := lockStateDir(stateDir)
	if err != nil {
		t.Fatalf("lockStateDir: %v", err)
	}

	var stdout, stderr bytes.Buffer
	code := dispatch(ctx, []string{"run", "-s", stateDir, "--isolation", "none", workDir}, &stdout, &stderr)
	if code != ExitInternal {
		t.Fatalf("locked run: code = %d, want ExitInternal (%d); stderr: %s", code, ExitInternal, stderr.String())
	}
	if !strings.Contains(stderr.String(), "another zeroci run is using this state directory") {
		t.Errorf("unexpected stderr: %s", stderr.String())
	}

	unlock()
	stdout.Reset()
	stderr.Reset()
	if code := dispatch(ctx, []string{"run", "-s", stateDir, "--isolation", "none", workDir}, &stdout, &stderr); code != ExitOK {
		t.Fatalf("run after unlock: code = %d, want ExitOK; stderr: %s", code, stderr.String())
	}
}

func TestRunAndInspectStatusAndLogs(t *testing.T) {
	ctx := context.Background()
	workDir := t.TempDir()
	stateDir := filepath.Join(t.TempDir(), "state")

	// Create .zeroci.yml
	cfgContent := `version: 1
checks:
  jobs:
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
	code := dispatch(ctx, []string{"run", "-s", stateDir, "--isolation", "none", workDir}, &stdout, &stderr)
	if code != ExitOK {
		t.Fatalf("run failed with code %d: stderr=%s stdout=%s", code, stderr.String(), stdout.String())
	}

	runOut := stdout.String()
	for _, want := range []string{"] lint     running\n", "] unit     success ", " success (2 jobs, "} {
		if !strings.Contains(runOut, want) {
			t.Errorf("run output lacks %q, got: %s", want, runOut)
		}
	}

	// 2. Check status list
	stdout.Reset()
	stderr.Reset()
	code = dispatch(ctx, []string{"status", "-s", stateDir}, &stdout, &stderr)
	if code != ExitOK {
		t.Fatalf("status list failed with code %d: %s", code, stderr.String())
	}
	statusListOut := stdout.String()
	if !strings.Contains(statusListOut, "success") {
		t.Errorf("expected status list to show success, got: %s", statusListOut)
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
	code = dispatch(ctx, []string{"status", "-s", stateDir, runID}, &stdout, &stderr)
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
	code = dispatch(ctx, []string{"logs", "-s", stateDir, runID, "lint"}, &stdout, &stderr)
	if code != ExitOK {
		t.Fatalf("logs failed with code %d: %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "linting code") {
		t.Errorf("expected 'linting code' in lint log, got: %s", stdout.String())
	}

	// 5. View all logs for run
	stdout.Reset()
	stderr.Reset()
	code = dispatch(ctx, []string{"logs", "-s", stateDir, runID}, &stdout, &stderr)
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
  jobs:
    broken:
      run: "false"
`
	if err := os.WriteFile(filepath.Join(workDir, ".zeroci.yml"), []byte(cfgContent), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	var stdout, stderr bytes.Buffer
	code := dispatch(ctx, []string{"run", "-s", stateDir, "--isolation", "none", workDir}, &stdout, &stderr)
	if code != ExitRunFailed {
		t.Fatalf("expected ExitRunFailed (%d), got %d (stderr: %s)", ExitRunFailed, code, stderr.String())
	}
}
