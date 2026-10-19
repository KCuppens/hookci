package sink

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func TestDrainAndAckOutbox(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatalf("Open db: %v", err)
	}
	defer db.Close()

	run := store.Run{
		ID: "01j7testrun", Repo: "test/repo", SHA: "abc", Ref: "main", Event: "local",
		Kind: "check", TrustDomain: "trusted:local/repo",
	}
	if err := db.CreateRun(ctx, run, []store.Job{{Name: "lint"}, {Name: "test", Needs: []string{"lint"}}}); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if err := db.Transition(ctx, run.ID, []store.RunState{store.RunQueued}, store.RunRunning, ""); err != nil {
		t.Fatalf("Transition: %v", err)
	}
	if err := db.TransitionJob(ctx, run.ID, "lint", []store.JobState{store.JobQueued}, store.JobRunning, store.JobUpdate{}); err != nil {
		t.Fatalf("TransitionJob running: %v", err)
	}
	dur := int64(42)
	if err := db.TransitionJob(ctx, run.ID, "lint", []store.JobState{store.JobRunning}, store.JobFailed,
		store.JobUpdate{DurationMS: &dur, Reason: "exit status 1"}); err != nil {
		t.Fatalf("TransitionJob failed: %v", err)
	}
	pending, err := db.Pending(ctx, 0, 0)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}

	var buf bytes.Buffer
	s := NewStdout(&buf)
	if err := s.Drain(ctx, db); err != nil {
		t.Fatalf("Drain: %v", err)
	}

	want := "[run 01j7testrun] queued\n" +
		"[run 01j7testrun] planned lint, test\n" +
		"[run 01j7testrun] running\n" +
		"[job 01j7testrun/lint] running\n" +
		"[job 01j7testrun/lint] failed duration_ms=42\n"
	if got := buf.String(); got != want {
		t.Errorf("drain output:\n%s\nwant:\n%s", got, want)
	}

	remaining, err := db.Pending(ctx, 0, 0)
	if err != nil {
		t.Fatalf("Pending after drain: %v", err)
	}
	if len(remaining) != 0 {
		t.Errorf("expected 0 remaining outbox rows, got %d", len(remaining))
	}
	acked, err := db.GetHWM(ctx, store.HWMOutAcked)
	if err != nil || acked != pending[len(pending)-1].Seq {
		t.Errorf("out_acked = %d, %v; want %d", acked, err, pending[len(pending)-1].Seq)
	}
}

func TestEmitUnknownKind(t *testing.T) {
	var buf bytes.Buffer
	if err := NewStdout(&buf).Emit(context.Background(), store.OutboxItem{Seq: 9, Kind: "custom", Payload: []byte("raw")}); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	if !strings.Contains(buf.String(), "[custom seq=9] raw") {
		t.Errorf("output = %q, want raw fallback", buf.String())
	}
}
