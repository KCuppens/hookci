//go:build unix

package execx

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// lockedBuffer is written by the group's copy goroutine while the test reads it.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestPgroupTerminateEscalates(t *testing.T) {
	var out lockedBuffer
	// An ignored SIGTERM is inherited across exec, so both sh and sleep
	// survive the SIGTERM and only SIGKILL ends the group.
	g, err := StartGroup(context.Background(), Cmd{
		Name:   "/bin/sh",
		Args:   []string{"-c", `trap "" TERM; echo ready; sleep 30`},
		Stdout: &out,
	})
	if err != nil {
		t.Fatalf("StartGroup: %v", err)
	}
	waitForOutput(t, &out, "ready")

	const grace = 200 * time.Millisecond
	start := time.Now()
	if err := g.Terminate(grace); err != nil {
		t.Fatalf("Terminate: %v", err)
	}
	elapsed := time.Since(start)
	if elapsed < grace {
		t.Fatalf("Terminate returned after %v, before the %v grace", elapsed, grace)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("Terminate took %v", elapsed)
	}
	code, err := g.Wait()
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if code != 128+9 {
		t.Fatalf("exit code = %d, want %d (SIGKILL)", code, 128+9)
	}
}

func TestPgroupWaitExitCodeAndEmptyEnv(t *testing.T) {
	var out lockedBuffer
	g, err := StartGroup(context.Background(), Cmd{
		Name:   "/bin/sh",
		Args:   []string{"-c", `printf '%s' "${HOME-unset}"; exit 3`},
		Stdout: &out,
	})
	if err != nil {
		t.Fatalf("StartGroup: %v", err)
	}
	code, err := g.Wait()
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if code != 3 {
		t.Fatalf("exit code = %d, want 3", code)
	}
	if again, _ := g.Wait(); again != 3 {
		t.Fatalf("second Wait = %d, want 3", again)
	}
	if out.String() != "unset" {
		t.Fatalf("nil Env leaked the agent environment: HOME=%q", out.String())
	}
}

func TestPgroupWaitDoesNotHangOnBackgroundChild(t *testing.T) {
	var out lockedBuffer
	g, err := StartGroup(context.Background(), Cmd{
		Name:   "/bin/sh",
		Args:   []string{"-c", "sleep 30 & exit 0"},
		Stdout: &out,
	})
	if err != nil {
		t.Fatalf("StartGroup: %v", err)
	}
	done := make(chan struct{})
	go func() {
		_, _ = g.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Wait blocked on a background child holding stdout")
	}
}

func waitForOutput(t *testing.T, buf *lockedBuffer, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(buf.String(), want) {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %q", want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
