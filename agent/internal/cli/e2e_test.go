package cli_test

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/cli"
	"github.com/KCuppens/zerocideploy/agent/internal/detect"
)

func TestNodeAppEndToEnd(t *testing.T) {
	// Locate examples/node-app relative to repo root
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("failed to get caller path")
	}
	repoRoot := filepath.Join(filepath.Dir(thisFile), "..", "..", "..")
	entries, err := os.ReadDir(filepath.Join(repoRoot, "examples", "node-app"))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(repoRoot, "examples", "node-app", e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		files[e.Name()] = string(b)
	}
	// zeroci run executes the committed HEAD, so run a repository of its own.
	nodeAppDir := cli.CommitWorkDir(t, files)

	det, err := detect.DetectDir(nodeAppDir)
	if err != nil {
		t.Fatalf("DetectDir(examples/node-app): %v", err)
	}
	var detected []string
	for name := range det.Config.ZeroCIConfig.Checks.Jobs {
		detected = append(detected, name)
	}
	slices.Sort(detected)
	if want := []string{"lint", "test", "typecheck"}; !reflect.DeepEqual(detected, want) {
		t.Fatalf("detected jobs = %v, want %v", detected, want)
	}

	stateDir := filepath.Join(t.TempDir(), "zeroci-state")

	var stdout, stderr bytes.Buffer
	t.Chdir(nodeAppDir)
	code := cli.Main([]string{"--state-dir", stateDir, "--isolation", "none", "run"}, &stdout, &stderr)
	if code != cli.ExitOK {
		t.Fatalf("expected ExitOK (%d), got %d (stderr: %s, stdout: %s)",
			cli.ExitOK, code, stderr.String(), stdout.String())
	}

	out := stdout.String()
	// Must have detected and run all three npm scripts: lint, typecheck, test
	for _, expectedJob := range []string{"lint", "typecheck", "test"} {
		if !strings.Contains(out, expectedJob) {
			t.Errorf("expected job %q in output, got:\n%s", expectedJob, out)
		}
	}

	// Verify status command on state directory
	stdout.Reset()
	stderr.Reset()
	code = cli.Main([]string{"--state-dir", stateDir, "status"}, &stdout, &stderr)
	if code != cli.ExitOK {
		t.Fatalf("status failed: %d (stderr: %s)", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "success") {
		t.Errorf("expected success in status, got: %s", stdout.String())
	}

	// Parse runID
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(lines) < 2 {
		t.Fatalf("expected at least 2 lines in status, got: %s", stdout.String())
	}
	runID := strings.Fields(lines[1])[0]

	// Verify logs for test job
	stdout.Reset()
	stderr.Reset()
	code = cli.Main([]string{"--state-dir", stateDir, "logs", runID, "test"}, &stdout, &stderr)
	if code != cli.ExitOK {
		t.Fatalf("logs failed: %d (stderr: %s)", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "unit tests passed") {
		t.Errorf("expected 'unit tests passed' in test logs, got: %s", stdout.String())
	}
}
