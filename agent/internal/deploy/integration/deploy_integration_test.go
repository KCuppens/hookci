//go:build integration

package integration

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/store"
)

// planSteps are the steps of a compose-bluegreen deploy, in order.
var planSteps = []string{"build", "prepare", "migrate", "start", "health", "swap", "verify", "finalize"}

func requireState(t *testing.T, r store.DeployRun, want string) {
	t.Helper()
	if r.State != want {
		t.Fatalf("run %s ended %s (error %q), want %s", r.RunID, r.State, r.Error, want)
	}
}

// TestIntegration_ZeroDowntime deploys 20 versions while GET / runs at
// 50 req/s through caddy: no request may fail, and the last version serves.
func TestIntegration_ZeroDowntime(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	requireState(t, h.deploy(t, "v0", nil), store.DeploySuccess)

	l := h.startLoad(50)
	for i := 1; i <= 20; i++ {
		r := h.deploy(t, fmt.Sprintf("v%d", i), nil)
		if r.State != store.DeploySuccess {
			l.stop()
			requireState(t, r, store.DeploySuccess)
		}
	}
	l.stop()

	t.Logf("load: %d requests answered, %d failed", l.ok.Load(), l.failed.Load())
	if n := l.failed.Load(); n != 0 {
		t.Fatalf("%d requests failed during 20 deploys; first failures:\n%s", n, strings.Join(l.samples, "\n"))
	}
	if l.ok.Load() == 0 {
		t.Fatal("the load generator got no answers")
	}
	h.requireConsistent(t, "v20")
}

// TestIntegration_HealthFailRollsBack deploys a version whose /healthz
// fails: the run fails at health and the previous version keeps serving
// with the marker and route file untouched.
func TestIntegration_HealthFailRollsBack(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	requireState(t, h.deploy(t, "v1", nil), store.DeploySuccess)
	marker, route := h.marker(t), h.routeFile(t)

	r := h.deploy(t, "v2", map[string]string{"FAIL_HEALTH": "1"})
	requireState(t, r, store.DeployFailed)
	if got := h.failedStep(t, r.RunID); got != "health" {
		t.Fatalf("failed step %q, want health", got)
	}
	h.requireFailedEvent(t, r.RunID, "health")
	if got := h.marker(t); got != marker {
		t.Fatalf("marker changed from %q to %q", marker, got)
	}
	if got := h.routeFile(t); got != route {
		t.Fatalf("route file changed:\nbefore:\n%s\nafter:\n%s", route, got)
	}
	h.requireConsistent(t, "v1")
}

// TestIntegration_VerifyFailRollsBack makes the new version fail every
// request once verify watches it: the run fails at verify, the route file
// is restored and the marker never moves.
func TestIntegration_VerifyFailRollsBack(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	requireState(t, h.deploy(t, "v1", nil), store.DeploySuccess)
	marker, route := h.marker(t), h.routeFile(t)

	runID := h.startDeploy(t, "v2", nil)
	h.waitStepRunning(t, runID, "verify")
	data := filepath.Join(h.spec.workDir(store.DeployRun{RunID: runID}), "data")
	if err := os.MkdirAll(data, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "fail-after-start"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	r := h.wait(t, runID)
	requireState(t, r, store.DeployFailed)
	if got := h.failedStep(t, runID); got != "verify" {
		t.Fatalf("failed step %q, want verify", got)
	}
	h.requireFailedEvent(t, runID, "verify")
	if got := h.routeFile(t); got != route {
		t.Fatalf("route file not restored:\nbefore:\n%s\nafter:\n%s", route, got)
	}
	if got := h.marker(t); got != marker {
		t.Fatalf("marker changed from %q to %q", marker, got)
	}
	h.requireConsistent(t, "v1")
}

// TestIntegration_KillAtEachStep SIGKILLs the agent while each step of a
// deploy runs, restarts it and retries the run with `hookci retry`: every
// time the run must succeed with one color serving, the marker,
// deploy_state and route file agreeing, and no containers of the other
// color left.
func TestIntegration_KillAtEachStep(t *testing.T) {
	h := newHarness(t, harnessOpts{subprocess: true})
	hookci := buildHookci(t)

	child := h.startAgent(t, "")
	base := h.queueRun(t, "base", nil)
	requireState(t, h.wait(t, base), store.DeploySuccess)
	stopAgent(t, child)
	if got := h.stepNames(t, base); !slices.Equal(got, planSteps) {
		t.Fatalf("compose-bluegreen steps are %v, the test kills at %v", got, planSteps)
	}
	h.requireConsistent(t, "base")

	for _, step := range planSteps {
		ok := t.Run(step, func(t *testing.T) {
			version := "kill-" + step
			runID := h.queueRun(t, version, nil)
			held := h.startAgent(t, step)
			h.waitStepRunning(t, runID, step)
			killAgent(t, held)

			child := h.startAgent(t, "")
			h.waitState(t, runID, store.DeployInterrupted)
			out := retryRun(t, hookci, h.spec.StateDir, runID)
			if !strings.Contains(out, "queued retry of "+runID) {
				t.Fatalf("hookci retry printed %q", out)
			}
			requireState(t, h.wait(t, runID), store.DeploySuccess)
			stopAgent(t, child)
			h.requireConsistent(t, version)
		})
		if !ok {
			break
		}
	}
}

// retryRun runs `hookci retry`, again while the restarted agent is not yet
// listening on its control socket, and returns its output.
func retryRun(t *testing.T, hookci, stateDir, runID string) string {
	t.Helper()
	var out []byte
	waitFor(t, time.Minute, "hookci retry "+runID+" to reach the agent", func() bool {
		var err error
		out, err = exec.Command(hookci, "retry", runID, "--state-dir", stateDir).CombinedOutput()
		if err != nil {
			t.Logf("hookci retry: %v: %s", err, out)
			return false
		}
		return true
	})
	return string(out)
}

// TestIntegration_GCKeepsActive deploys 20 versions; GC after each run
// leaves retain.images images of the project, the active and the previous
// one among them. The verify window is shortened: this test is about GC.
func TestIntegration_GCKeepsActive(t *testing.T) {
	h := newHarness(t, harnessOpts{verifyWindow: "2s", verifyInterval: "1s"})
	for i := 1; i <= 20; i++ {
		requireState(t, h.deploy(t, fmt.Sprintf("v%d", i), nil), store.DeploySuccess)
	}

	d, err := h.spec.deployment(itEnv, "")
	if err != nil {
		t.Fatal(err)
	}
	tags := projectImages(t, h.spec.Project)
	if len(tags) != d.Retain.Images {
		t.Fatalf("%d images of %s left (%v), want retain.images = %d", len(tags), h.spec.Project, tags, d.Retain.Images)
	}
	kept, err := h.st.LastSucceededRuns(context.Background(), itRepo, itEnv, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(kept) != 2 {
		t.Fatalf("%d succeeded runs, want 2", len(kept))
	}
	for _, r := range kept {
		if !slices.Contains(tags, r.SHA[:7]) {
			t.Fatalf("image %s:%s of run %s was removed; left: %v", h.spec.Project, r.SHA[:7], r.RunID, tags)
		}
	}
	h.requireConsistent(t, "v20")
}
