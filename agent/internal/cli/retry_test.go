package cli

import (
	"bytes"
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/control"
	"github.com/KCuppens/hookci/agent/internal/deploy"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// recordingSched records the runs the retry handler queues.
type recordingSched struct{ queued []string }

func (s *recordingSched) Enqueue(_ context.Context, runID string, retry bool) {
	if retry {
		s.queued = append(s.queued, runID)
	}
}

// retryAgent is an agent store holding one deploy run in state, served on
// the state dir's control socket by the retry handler the agent registers.
func retryAgent(t *testing.T, state string) (Deps, *store.Store, *recordingSched) {
	t.Helper()
	stateDir := t.TempDir()
	st, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.InsertDeployRun(context.Background(), store.DeployRun{
		RunID: "run_dep", Repo: "acme/web", Env: "prod", SHA: "abc1234", Ref: "refs/heads/main",
		Strategy: "compose-bluegreen", State: state, CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	sched := &recordingSched{}
	srv, err := control.Listen(stateDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv.Handle(deploy.RetryOp, deploy.RetryControl(st, sched))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = srv.Serve(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return Deps{Globals: Globals{StateDir: stateDir}}, st, sched
}

func retryOf(d Deps, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := cmdRetry(context.Background(), d, args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestRetryCommand_Success(t *testing.T) {
	for _, state := range []string{store.DeployFailed, store.DeployInterrupted} {
		t.Run(state, func(t *testing.T) {
			d, st, sched := retryAgent(t, state)
			code, stdout, stderr := retryOf(d, "run_dep")
			if code != ExitOK || stdout != "queued retry of run_dep (attempt 2)\n" || stderr != "" {
				t.Errorf("retry = %d, %q, %q", code, stdout, stderr)
			}
			if len(sched.queued) != 1 || sched.queued[0] != "run_dep" {
				t.Errorf("queued retries = %v, want run_dep", sched.queued)
			}
			run, err := st.GetDeployRun(context.Background(), "run_dep")
			if err != nil || run.State != store.DeployQueued || run.Attempt != 2 {
				t.Errorf("run = %s attempt %d, %v; want Queued attempt 2", run.State, run.Attempt, err)
			}
		})
	}
}

func TestRetryCommand_NotRetryable(t *testing.T) {
	for _, state := range []string{store.DeploySuccess, store.DeployRunning} {
		t.Run(state, func(t *testing.T) {
			d, _, sched := retryAgent(t, state)
			code, stdout, stderr := retryOf(d, "run_dep")
			want := "hookci: run run_dep is " + state + "; only Failed or Interrupted runs can be retried\n"
			if code != ExitRunFailed || stdout != "" || stderr != want {
				t.Errorf("retry = %d, %q, %q; want 1 and %q", code, stdout, stderr, want)
			}
			if len(sched.queued) != 0 {
				t.Errorf("queued retries = %v, want none", sched.queued)
			}
		})
	}
}

func TestRetryCommand_AgentNotRunning(t *testing.T) {
	const want = "hookci: agent is not running; start it with systemctl start hookci-agent@<installation>\n"
	d := Deps{Globals: Globals{StateDir: t.TempDir()}}
	if code, stdout, stderr := retryOf(d, "run_dep"); code != ExitRunFailed || stdout != "" || stderr != want {
		t.Errorf("retry = %d, %q, %q; want 1 and %q", code, stdout, stderr, want)
	}
}

func TestRetryCommand_Usage(t *testing.T) {
	d, _, sched := retryAgent(t, store.DeployFailed)
	for _, args := range [][]string{nil, {"run_a", "run_b"}, {"run_dep", "--installation", "-1"}} {
		if code, _, _ := retryOf(d, args...); code != ExitUsage {
			t.Errorf("retry %q = %d, want %d", args, code, ExitUsage)
		}
	}
	if len(sched.queued) != 0 {
		t.Errorf("queued retries = %v, want none", sched.queued)
	}
}
