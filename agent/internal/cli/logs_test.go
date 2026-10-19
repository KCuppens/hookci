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
	// Plan order is setup, lint, test, whatever order the logs were written in.
	writeLog(t, d, failedRun, "test", "FAIL x_test\n")
	writeLog(t, d, failedRun, "lint", "lint ok\n")
	writeLog(t, d, failedRun, "setup", "npm ci\n")

	var stdout syncBuffer
	code, stderr := logsOf(context.Background(), d, &stdout, failedRun)
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr %q", code, stderr)
	}
	if want := "==> setup <==\nnpm ci\n\n==> lint <==\nlint ok\n\n==> test <==\nFAIL x_test\n"; stdout.String() != want {
		t.Errorf("stdout = %q, want %q", stdout.String(), want)
	}

	stdout.buf.Reset()
	if code, _ := logsOf(context.Background(), d, &stdout, failedRun, "test"); code != ExitOK || stdout.String() != "FAIL x_test\n" {
		t.Errorf("logs run test = %d, %q", code, stdout.String())
	}
	stdout.buf.Reset()
	if code, _ := logsOf(context.Background(), d, &stdout, failedRun, "setup"); code != ExitOK || stdout.String() != "npm ci\n" {
		t.Errorf("logs run setup = %d, %q", code, stdout.String())
	}
	stdout.buf.Reset()
	if code, stderr := logsOf(context.Background(), d, &stdout, failedRun, "deploy"); code != ExitUsage ||
		stderr != "zeroci: run "+failedRun+" has no job \"deploy\"\n" {
		t.Errorf("logs run deploy = %d, %q", code, stderr)
	}
}

// TestLogsPrintNoSetupLog covers a run that never reached setup.
func TestLogsPrintNoSetupLog(t *testing.T) {
	d, _, _ := seedStore(t)
	writeLog(t, d, failedRun, "lint", "lint ok\n")
	var stdout syncBuffer
	if code, stderr := logsOf(context.Background(), d, &stdout, failedRun); code != ExitOK {
		t.Fatalf("exit = %d, stderr %q", code, stderr)
	}
	if want := "==> lint <==\nlint ok\n\n==> test <==\n"; stdout.String() != want {
		t.Errorf("stdout = %q, want %q", stdout.String(), want)
	}
}

// startRunning moves queuedRun and its lint job to running.
func startRunning(t *testing.T, db *store.Store) {
	t.Helper()
	ctx := context.Background()
	if err := db.Transition(ctx, queuedRun, []store.RunState{store.RunQueued}, store.RunRunning, ""); err != nil {
		t.Fatal(err)
	}
	if err := db.TransitionJob(ctx, queuedRun, "lint", []store.JobState{store.JobQueued}, store.JobRunning, store.JobUpdate{}); err != nil {
		t.Fatal(err)
	}
}

// fakeTicker makes d.After report each wait on waiting and fire on tick.
func fakeTicker(d *Deps) (waiting chan time.Duration, tick chan time.Time) {
	waiting = make(chan time.Duration)
	tick = make(chan time.Time)
	d.After = func(dur time.Duration) <-chan time.Time {
		waiting <- dur
		return tick
	}
	return waiting, tick
}

// holdAgentLock takes the state dir lock as a running agent would.
func holdAgentLock(t *testing.T, d Deps) (unlock func()) {
	t.Helper()
	unlock, err := lockStateDir(d.Globals.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unlock)
	return unlock
}

func TestLogsFollow(t *testing.T) {
	d, db, _ := seedStore(t)
	ctx := context.Background()
	startRunning(t, db)
	holdAgentLock(t, d)
	writeLog(t, d, queuedRun, "setup", "npm ci\n")
	writeLog(t, d, queuedRun, "lint", "one\n")

	waiting, tick := fakeTicker(&d)
	var stdout syncBuffer
	done := make(chan int, 1)
	go func() {
		code, _ := logsOf(ctx, d, &stdout, queuedRun, "-f")
		done <- code
	}()

	if dur := <-waiting; dur != 500*time.Millisecond {
		t.Errorf("poll interval = %v, want 500ms", dur)
	}
	if got := stdout.String(); got != "==> setup <==\nnpm ci\n\n==> lint <==\none\n" {
		t.Fatalf("first poll = %q", got)
	}
	writeLog(t, d, queuedRun, "lint", "two\n")
	tick <- time.Time{}
	<-waiting
	if got := stdout.String(); got != "==> setup <==\nnpm ci\n\n==> lint <==\none\ntwo\n" {
		t.Fatalf("second poll = %q", got)
	}

	// The job ends after writing its last line; the run is still tearing down.
	writeLog(t, d, queuedRun, "lint", "three\n")
	if err := db.TransitionJob(ctx, queuedRun, "lint", []store.JobState{store.JobRunning}, store.JobSuccess, store.JobUpdate{}); err != nil {
		t.Fatal(err)
	}
	tick <- time.Time{}
	<-waiting

	// Teardown writes to the setup log before the run turns terminal: one
	// more poll drains it.
	writeLog(t, d, queuedRun, "setup", "teardown ok\n")
	if err := db.Transition(ctx, queuedRun, []store.RunState{store.RunRunning}, store.RunSuccess, ""); err != nil {
		t.Fatal(err)
	}
	tick <- time.Time{}
	select {
	case code := <-done:
		if code != ExitOK {
			t.Errorf("exit = %d", code)
		}
	case <-waiting:
		t.Fatal("logs -f kept polling after the run ended")
	case <-time.After(10 * time.Second):
		t.Fatal("logs -f did not return")
	}
	if got, want := stdout.String(), "==> setup <==\nnpm ci\n\n==> lint <==\none\ntwo\nthree\n\n==> setup <==\nteardown ok\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

// TestLogsFollowAgentGone: a killed agent leaves its run and jobs active in
// the store; logs -f drains the logs and stops once the state lock is free.
func TestLogsFollowAgentGone(t *testing.T) {
	d, db, _ := seedStore(t)
	startRunning(t, db)
	unlock := holdAgentLock(t, d)
	writeLog(t, d, queuedRun, "lint", "one\n")

	waiting, tick := fakeTicker(&d)
	var stdout syncBuffer
	type result struct {
		code   int
		stderr string
	}
	done := make(chan result, 1)
	go func() {
		code, stderr := logsOf(context.Background(), d, &stdout, queuedRun, "-f")
		done <- result{code, stderr}
	}()

	<-waiting
	writeLog(t, d, queuedRun, "lint", "last words\n")
	unlock()
	tick <- time.Time{}
	select {
	case r := <-done:
		if r.code != ExitOK || r.stderr != "zeroci: no zeroci process is running run "+queuedRun+"; stopped following\n" {
			t.Errorf("logs -f = %d, %q", r.code, r.stderr)
		}
	case <-waiting:
		t.Fatal("logs -f kept polling after the agent was gone")
	case <-time.After(10 * time.Second):
		t.Fatal("logs -f did not return")
	}
	if got, want := stdout.String(), "==> lint <==\none\nlast words\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}

	// With no agent from the start, logs -f prints once and returns.
	d.After = func(time.Duration) <-chan time.Time {
		t.Error("logs -f waited without an agent")
		return nil
	}
	stdout.buf.Reset()
	if code, _ := logsOf(context.Background(), d, &stdout, queuedRun, "lint", "-f"); code != ExitOK || stdout.String() != "one\nlast words\n" {
		t.Errorf("logs -f without agent = %d, %q", code, stdout.String())
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
