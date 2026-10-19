package sink

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func TestEmitTransitions(t *testing.T) {
	var buf bytes.Buffer
	s := NewStdout(&buf)
	ctx := context.Background()

	// 1. Run transition
	runEv := store.OutboxEvent{
		Seq:       1,
		RunID:     "01j7run",
		EventType: store.EventRunTransition,
		Payload:   `{"run_id":"01j7run","repo":"test/repo","ref":"main","from_state":"Queued","to_state":"Running"}`,
	}
	if err := s.Emit(ctx, runEv); err != nil {
		t.Fatalf("Emit runEv: %v", err)
	}

	// 2. Job transition
	jobEv := store.OutboxEvent{
		Seq:       2,
		RunID:     "01j7run",
		EventType: store.EventJobTransition,
		Payload:   `{"run_id":"01j7run","job_name":"lint","from_state":"queued","to_state":"running"}`,
	}
	if err := s.Emit(ctx, jobEv); err != nil {
		t.Fatalf("Emit jobEv: %v", err)
	}

	out := buf.String()
	if !strings.Contains(out, "[run 01j7run] Queued -> Running (repo=test/repo ref=main)") {
		t.Errorf("unexpected run transition output: %s", out)
	}
	if !strings.Contains(out, "[job 01j7run/lint] queued -> running") {
		t.Errorf("unexpected job transition output: %s", out)
	}
}

func TestDrainAndAckOutbox(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := store.Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("Open db: %v", err)
	}
	defer db.Close()

	// Create run
	run := &store.Run{
		ID:          "01j7testrun",
		Repo:        "owner/repo",
		Ref:         "main",
		TrustDomain: "local",
	}
	if err := db.CreateRun(ctx, run, []string{"lint"}); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	// Transition run state (writes to outbox in tx)
	if err := db.TransitionRun(ctx, "01j7testrun", "Queued", "Running", ""); err != nil {
		t.Fatalf("TransitionRun: %v", err)
	}

	// Verify outbox has events
	events, err := db.FetchOutbox(ctx, 0, 10)
	if err != nil {
		t.Fatalf("FetchOutbox: %v", err)
	}
	if len(events) == 0 {
		t.Fatalf("expected outbox events before drain")
	}

	var buf bytes.Buffer
	s := NewStdout(&buf)

	if err := s.Drain(ctx, db); err != nil {
		t.Fatalf("Drain: %v", err)
	}

	if !strings.Contains(buf.String(), "[run 01j7testrun] Queued -> Running") {
		t.Errorf("expected drain output to contain run transition: %s", buf.String())
	}

	// Verify outbox is acked and drained
	remaining, err := db.FetchOutbox(ctx, 0, 10)
	if err != nil {
		t.Fatalf("FetchOutbox after drain: %v", err)
	}
	if len(remaining) != 0 {
		t.Errorf("expected 0 remaining outbox rows, got %d", len(remaining))
	}
}
