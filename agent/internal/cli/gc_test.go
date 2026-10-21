package cli

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/clock"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/control"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/gc"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// serveGC serves the control op "gc" on stateDir from a collector over a
// fake docker that lists images web:0000001..web:0000004 for an env that
// keeps 2, plus a failed deploy run with a checkout dir. The build cache cap
// is set to 10 GiB.
func serveGC(t *testing.T, stateDir string) *execx.Fake {
	t.Helper()
	ctx := context.Background()
	now := time.Date(2025, 3, 1, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFake(now)
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"), store.WithClock(clk.Now))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.InsertDeployRun(ctx, store.DeployRun{RunID: "dep_failed", Repo: "acme/web", Env: "prod",
		SHA: strings.Repeat("a", 40), Ref: "refs/heads/main", Strategy: "recreate", State: store.DeployFailed,
		CreatedAt: now, FinishedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(stateDir, "deploy-work", "dep_failed"), 0o700); err != nil {
		t.Fatal(err)
	}

	fake := &execx.Fake{}
	var ls strings.Builder
	for i := 1; i <= 4; i++ {
		fmt.Fprintf(&ls, `{"CreatedAt":%q,"ID":"sha256:%064x","Repository":"web","Tag":"%07x"}`+"\n",
			now.Add(time.Duration(i)*time.Hour).Format("2006-01-02 15:04:05 -0700 MST"), i, i)
	}
	fake.On("docker", []string{"image", "ls"}, execx.FakeResponse{Stdout: ls.String()})
	fake.On("docker", []string{"builder", "prune", "--help"}, execx.FakeResponse{Stdout: "      --max-used-space bytes\n"})
	collector := &gc.Collector{
		Runner: fake, Store: st, StateDir: stateDir, Clock: clk,
		Cfg: config.AgentConfig{Gc: &config.AgentConfigGc{BuildCacheMaxBytes: 10 << 30}},
		Repos: func(context.Context) ([]gc.RepoEnv, error) {
			return []gc.RepoEnv{{Repo: "acme/web", Env: "prod", Project: "web", Retain: 2}}, nil
		},
	}

	srv, err := control.Listen(stateDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv.Handle("gc", collector.HandleControl)
	sctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = srv.Serve(sctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return fake
}

func gcCmd(t *testing.T, stateDir string, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	d := Deps{Globals: Globals{StateDir: stateDir}}
	code := cmdGC(context.Background(), d, args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestGCCommand_DryRun(t *testing.T) {
	stateDir := t.TempDir()
	fake := serveGC(t, stateDir)
	work := filepath.Join(stateDir, "deploy-work", "dep_failed")

	code, stdout, stderr := gcCmd(t, stateDir, "--dry-run")
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr %q", code, stderr)
	}
	want := "would remove image web:0000001\n" +
		"would remove image web:0000002\n" +
		"would cap build cache: --max-used-space 10737418240\n" +
		"would remove run dir " + work + "\n"
	if stdout != want {
		t.Errorf("stdout =\n%s\nwant\n%s", stdout, want)
	}
	if fake.Called("docker", "image", "rm") || fake.Called("docker", "builder", "prune", "--force") {
		t.Errorf("dry run removed something: %v", fake.Calls)
	}
	if _, err := os.Stat(work); err != nil {
		t.Errorf("dry run removed %s: %v", work, err)
	}
}

func TestGCCommand_Apply(t *testing.T) {
	stateDir := t.TempDir()
	fake := serveGC(t, stateDir)
	fake.On("docker", []string{"image", "rm", "web:0000002"}, execx.FakeResponse{Code: 1, Stderr: "image is in use"})
	fake.On("docker", []string{"image", "rm"}, execx.FakeResponse{})
	fake.On("docker", []string{"builder", "prune", "--force"}, execx.FakeResponse{})
	work := filepath.Join(stateDir, "deploy-work", "dep_failed")

	code, stdout, stderr := gcCmd(t, stateDir)
	if code != ExitInternal {
		t.Errorf("exit = %d, want %d for a failed removal", code, ExitInternal)
	}
	want := "removed image web:0000001\n" +
		"capped build cache: --max-used-space 10737418240\n" +
		"removed run dir " + work + "\n"
	if stdout != want {
		t.Errorf("stdout =\n%s\nwant\n%s", stdout, want)
	}
	if !strings.Contains(stderr, "remove image web:0000002") {
		t.Errorf("stderr = %q, want the failed removal", stderr)
	}
	if _, err := os.Stat(work); !os.IsNotExist(err) {
		t.Errorf("%s still exists: %v", work, err)
	}
}

func TestGCCommand_NotRunning(t *testing.T) {
	code, _, stderr := gcCmd(t, t.TempDir(), "--dry-run")
	if code != ExitInternal || !strings.Contains(stderr, "no agent is running") {
		t.Errorf("exit = %d stderr = %q, want %d and the not-running hint", code, stderr, ExitInternal)
	}
}
