//go:build integration

package recovery

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/netns"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
	"github.com/KCuppens/zerocideploy/agent/internal/source"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

// TestKill9RecoveryIntegration runs `zeroci run` on a sleeping job under
// systemd, kills the agent with SIGKILL while the job runs, then checks that
// Recover interrupts the run and leaves no unit, namespace or pasta behind.
func TestKill9RecoveryIntegration(t *testing.T) {
	testutil.RequireIntegration(t)
	if _, err := exec.LookPath("systemd-run"); err != nil {
		t.Skip("systemd-run not in PATH")
	}
	ctx := context.Background()

	bin := filepath.Join(t.TempDir(), "zeroci")
	if out, err := exec.Command("go", "build", "-o", bin, "github.com/KCuppens/zerocideploy/agent/cmd/zeroci").CombinedOutput(); err != nil {
		t.Fatalf("build zeroci: %v\n%s", err, out)
	}
	work := commitFixture(t, map[string]string{
		".zeroci.yml": "version: 1\nchecks:\n  jobs:\n    sleep:\n      run: sleep 300\n",
	})
	// PrivateTmp hides /tmp from job units, so the state dir lives in /run.
	stateDir, err := os.MkdirTemp("/run", "zeroci-itest-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(stateDir) })

	logFile, err := os.Create(filepath.Join(t.TempDir(), "zeroci.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()
	output := func() string { b, _ := os.ReadFile(logFile.Name()); return string(b) }
	agent := exec.Command(bin, "--state-dir", stateDir, "--isolation", "systemd", "run")
	agent.Dir = work
	agent.Stdout, agent.Stderr = logFile, logFile
	if err := agent.Start(); err != nil {
		t.Fatalf("start zeroci run: %v", err)
	}
	t.Cleanup(func() { _ = agent.Process.Kill() })

	sd := &isolation.Systemd{}
	unit := waitForUnit(t, sd, output)

	if err := agent.Process.Kill(); err != nil {
		t.Fatalf("SIGKILL zeroci run: %v", err)
	}
	_ = agent.Wait()
	t.Cleanup(func() { _ = sd.Stop(ctx, unit) })

	db, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	runs, err := db.ListRuns(ctx, store.RunFilter{States: []store.RunState{store.RunRunning}})
	if err != nil || len(runs) != 1 {
		t.Fatalf("running runs after kill = %v, %v; want one\n%s", runs, err, output())
	}
	runID := runs[0].ID

	rep, err := Recover(ctx, Deps{
		Store:     db,
		Isolation: sd,
		Netns:     NetnsManager{Manager: &netns.Manager{}},
		Docker:    services.Docker{},
		Runner:    execx.OS{},
	})
	if err != nil {
		t.Fatalf("Recover: %v", err)
	}
	if len(rep.Errors) != 0 {
		t.Fatalf("Recover cleanup errors: %v", rep.Errors)
	}
	if !slices.Contains(rep.Interrupted, runID) || !slices.Contains(rep.UnitsStopped, unit) {
		t.Fatalf("report = %+v, want run %s interrupted and unit %s stopped", rep, runID, unit)
	}

	run, err := db.GetRun(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	if run.State != store.RunInterrupted || run.Reason != InterruptedReason {
		t.Fatalf("run = %s %q, want interrupted %q", run.State, run.Reason, InterruptedReason)
	}
	left, err := sd.ListUnits(ctx, isolation.UnitPrefix)
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 0 {
		t.Fatalf("units left after recovery: %v", left)
	}
	names, err := (&netns.Manager{}).ListNamespaces()
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(names, netns.NSName(runID)) {
		t.Fatalf("namespace %s left after recovery", netns.NSName(runID))
	}
	if err := (execx.OS{}).Run(ctx, execx.Cmd{Name: "pgrep", Args: []string{"-f", pastaPattern}}); err == nil {
		t.Fatal("pasta process left after recovery")
	}
}

// waitForUnit waits until the fixture's job unit is active and returns its
// name.
func waitForUnit(t *testing.T, sd *isolation.Systemd, output func() string) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		units, err := sd.ListUnits(context.Background(), isolation.UnitPrefix)
		if err != nil {
			t.Fatalf("list units: %v", err)
		}
		for _, u := range units {
			if u.Active == "active" {
				return u.Name
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("no active job unit within 2m; zeroci output:\n%s", output())
	return ""
}

// commitFixture writes files into a new git repository and commits them;
// `zeroci run` checks out the committed HEAD.
func commitFixture(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	env := append(source.SafeGitEnv(t.TempDir()),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	for _, args := range [][]string{
		{"init", "--quiet", "--initial-branch=main"},
		{"add", "-A"},
		{"commit", "--quiet", "-m", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir, cmd.Env = dir, env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return dir
}
