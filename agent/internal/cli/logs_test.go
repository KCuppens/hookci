package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/logpipe"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// writeLog appends text to job's log of runID.
func writeLog(t *testing.T, d Deps, runID, job, text string) {
	t.Helper()
	path := logpipe.LogPath(filepath.Join(d.Globals.StateDir, "runs", runID), job)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

func logsOf(ctx context.Context, d Deps, stdout *syncBuffer, args ...string) (int, string) {
	var stderr bytes.Buffer
	code := cmdLogs(ctx, d, args, stdout, &stderr)
	return code, stderr.String()
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestLogsPrintAll(t *testing.T) {
	d, _, _ := seedStore(t)
	// Plan order is lint then test, whatever order the logs were written in.
	writeLog(t, d, failedRun, "test", "FAIL x_test\n")
	writeLog(t, d, failedRun, "lint", "lint ok\n")

	var stdout syncBuffer
	code, stderr := logsOf(context.Background(), d, &stdout, failedRun)
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr %q", code, stderr)
	}
	if want := "==> lint <==\nlint ok\n\n==> test <==\nFAIL x_test\n"; stdout.String() != want {
		t.Errorf("stdout = %q, want %q", stdout.String(), want)
	}

	stdout.buf.Reset()
	if code, _ := logsOf(context.Background(), d, &stdout, failedRun, "test"); code != ExitOK || stdout.String() != "FAIL x_test\n" {
		t.Errorf("logs run test = %d, %q", code, stdout.String())
	}
	stdout.buf.Reset()
	if code, stderr := logsOf(context.Background(), d, &stdout, failedRun, "deploy"); code != ExitUsage ||
		stderr != "zeroci: run "+failedRun+" has no job \"deploy\"\n" {
		t.Errorf("logs run deploy = %d, %q", code, stderr)
	}
}

func TestLogsFollow(t *testing.T) {
	d, db, _ := seedStore(t)
	ctx := context.Background()
	if err := db.Transition(ctx, queuedRun, []store.RunState{store.RunQueued}, store.RunRunning, ""); err != nil {
		t.Fatal(err)
	}
	if err := db.TransitionJob(ctx, queuedRun, "lint", []store.JobState{store.JobQueued}, store.JobRunning, store.JobUpdate{}); err != nil {
		t.Fatal(err)
	}
	writeLog(t, d, queuedRun, "lint", "one\n")

	// The fake ticker reports each wait and fires when the test says so.
	waiting := make(chan time.Duration)
	tick := make(chan time.Time)
	d.After = func(dur time.Duration) <-chan time.Time {
		waiting <- dur
		return tick
	}
	var stdout syncBuffer
	done := make(chan int, 1)
	go func() {
		code, _ := logsOf(ctx, d, &stdout, queuedRun, "-f")
		done <- code
	}()

	if dur := <-waiting; dur != 500*time.Millisecond {
		t.Errorf("poll interval = %v, want 500ms", dur)
	}
	if got := stdout.String(); got != "==> lint <==\none\n" {
		t.Fatalf("first poll = %q", got)
	}
	writeLog(t, d, queuedRun, "lint", "two\n")
	tick <- time.Time{}
	<-waiting
	if got := stdout.String(); got != "==> lint <==\none\ntwo\n" {
		t.Fatalf("second poll = %q", got)
	}

	// The job ends after writing its last line: one more poll drains it.
	writeLog(t, d, queuedRun, "lint", "three\n")
	if err := db.TransitionJob(ctx, queuedRun, "lint", []store.JobState{store.JobRunning}, store.JobSuccess, store.JobUpdate{}); err != nil {
		t.Fatal(err)
	}
	tick <- time.Time{}
	select {
	case code := <-done:
		if code != ExitOK {
			t.Errorf("exit = %d", code)
		}
	case <-waiting:
		t.Fatal("logs -f kept polling after the job ended")
	case <-time.After(10 * time.Second):
		t.Fatal("logs -f did not return")
	}
	if got, want := stdout.String(), "==> lint <==\none\ntwo\nthree\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestLogsUnknownRun(t *testing.T) {
	d, _, _ := seedStore(t)
	var stdout syncBuffer
	code, stderr := logsOf(context.Background(), d, &stdout, "01JNDQ9000CCCCCCCCCCCCCCCC")
	if code != ExitUsage || stderr != "zeroci: run 01JNDQ9000CCCCCCCCCCCCCCCC not found\n" {
		t.Errorf("logs = %d, %q", code, stderr)
	}

	d.Globals.StateDir = filepath.Join(t.TempDir(), "empty")
	code, stderr = logsOf(context.Background(), d, &stdout, failedRun)
	if code != ExitUsage || stderr != "zeroci: run "+failedRun+" not found\n" {
		t.Errorf("logs without a store = %d, %q", code, stderr)
	}
}
