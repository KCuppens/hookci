package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

var statusBase = time.Date(2025, 3, 1, 12, 0, 0, 0, time.UTC)

const (
	failedRun = "01JNDQ7R00AAAAAAAAAAAAAAAA"
	queuedRun = "01JNDQ8000BBBBBBBBBBBBBBBB"
)

// seedStore writes a state dir with a failed run (lint ok, test failed)
// and a later queued run. Its clock is moved by advance.
func seedStore(t *testing.T) (deps, *store.Store, func(time.Duration)) {
	t.Helper()
	now := statusBase
	clock := func() time.Time { return now }
	d := deps{Globals: Globals{StateDir: t.TempDir()}, Clock: clock}
	db, err := store.Open(filepath.Join(d.Globals.StateDir, "agent.db"), store.WithClock(clock))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	exit := func(code int) *int { return &code }
	ms := func(n int64) *int64 { return &n }

	must(db.CreateRun(ctx, store.Run{
		ID: failedRun, Repo: "local/app", SHA: "0123456789abcdef0123456789abcdef01234567", Ref: "HEAD",
		Event: "local", Kind: "check", TrustDomain: "trusted:local/app",
	}, []store.Job{{Name: "lint"}, {Name: "test", Needs: []string{"lint"}}}))
	now = now.Add(time.Second)
	must(db.Transition(ctx, failedRun, []store.RunState{store.RunQueued}, store.RunRunning, ""))
	must(db.TransitionJob(ctx, failedRun, "lint", []store.JobState{store.JobQueued}, store.JobRunning, store.JobUpdate{}))
	now = now.Add(2 * time.Second)
	must(db.TransitionJob(ctx, failedRun, "lint", []store.JobState{store.JobRunning}, store.JobSuccess,
		store.JobUpdate{ExitCode: exit(0), DurationMS: ms(2000)}))
	must(db.TransitionJob(ctx, failedRun, "test", []store.JobState{store.JobQueued}, store.JobRunning, store.JobUpdate{}))
	now = now.Add(1500 * time.Millisecond)
	must(db.TransitionJob(ctx, failedRun, "test", []store.JobState{store.JobRunning}, store.JobFailed,
		store.JobUpdate{ExitCode: exit(1), DurationMS: ms(1500), Reason: "exit status 1"}))
	must(db.Transition(ctx, failedRun, []store.RunState{store.RunRunning}, store.RunFailed, "job test failed"))

	now = statusBase.Add(time.Minute)
	must(db.CreateRun(ctx, store.Run{
		ID: queuedRun, Repo: "local/app", SHA: "89abcdef0123456789abcdef0123456789abcdef", Ref: "HEAD",
		Event: "local", Kind: "check", TrustDomain: "trusted:local/app",
	}, []store.Job{{Name: "lint"}}))
	now = statusBase.Add(10 * time.Minute)
	return d, db, func(by time.Duration) { now = now.Add(by) }
}

func statusOf(d deps, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := cmdStatus(context.Background(), d, args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestStatusGolden(t *testing.T) {
	d, _, _ := seedStore(t)
	code, stdout, stderr := statusOf(d)
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr %q", code, stderr)
	}
	testutil.Golden(t, "status", []byte(stdout))
}

func TestStatusJSONGolden(t *testing.T) {
	d, _, _ := seedStore(t)
	code, stdout, stderr := statusOf(d, "--json")
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr %q", code, stderr)
	}
	testutil.Golden(t, "status_json", []byte(stdout))
}

func TestStatusEmptyStateDir(t *testing.T) {
	d := deps{Globals: Globals{StateDir: filepath.Join(t.TempDir(), "none")}, Clock: time.Now}
	if code, stdout, _ := statusOf(d); code != ExitOK || stdout != "ID  REPO  REF  SHA  STATE  AGE  DURATION\n" {
		t.Errorf("status = %d, %q", code, stdout)
	}
	if code, stdout, _ := statusOf(d, "--json"); code != ExitOK || stdout != "[]\n" {
		t.Errorf("status --json = %d, %q", code, stdout)
	}
	if _, err := os.Stat(d.Globals.StateDir); !os.IsNotExist(err) {
		t.Errorf("status created the state dir: %v", err)
	}
}

func TestStatusRunJobs(t *testing.T) {
	d, _, _ := seedStore(t)
	code, stdout, stderr := statusOf(d, failedRun)
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr %q", code, stderr)
	}
	var rows [][]string
	for _, line := range strings.Split(strings.TrimSuffix(stdout, "\n"), "\n") {
		rows = append(rows, strings.Fields(line))
	}
	want := [][]string{
		{"NAME", "STATE", "EXIT", "DURATION", "REASON"},
		{"lint", "success", "0", "2s"},
		{"test", "failed", "1", "1.5s", "exit", "status", "1"},
	}
	if len(rows) != len(want) {
		t.Fatalf("rows:\n%s", stdout)
	}
	for i := range want {
		if strings.Join(rows[i], " ") != strings.Join(want[i], " ") {
			t.Errorf("row %d = %q, want %q", i, rows[i], want[i])
		}
	}

	code, stdout, _ = statusOf(d, "--json", failedRun)
	if code != ExitOK || !strings.HasPrefix(stdout, "[\n  {\n    \"run_id\": \""+failedRun+"\",\n    \"name\": \"lint\"") {
		t.Errorf("status --json run = %d:\n%s", code, stdout)
	}

	code, _, stderr = statusOf(d, "01JNDQ9000CCCCCCCCCCCCCCCC")
	if code != ExitUsage || stderr != "zeroci: run 01JNDQ9000CCCCCCCCCCCCCCCC not found\n" {
		t.Errorf("unknown run = %d, %q", code, stderr)
	}
}
