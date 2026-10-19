package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/ids"
)

func newTestDB(t *testing.T) *DB {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

func TestOpen(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)

	if err := db.Ping(ctx); err != nil {
		t.Fatalf("db.Ping failed: %v", err)
	}

	// Verify WAL mode
	var journalMode string
	err := db.sql.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode)
	if err != nil {
		t.Fatalf("failed to query journal_mode: %v", err)
	}
	if journalMode != "wal" {
		t.Errorf("journal_mode = %s, want wal", journalMode)
	}

	// Verify foreign keys
	var fk int
	err = db.sql.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fk)
	if err != nil {
		t.Fatalf("failed to query foreign_keys: %v", err)
	}
	if fk != 1 {
		t.Errorf("foreign_keys = %d, want 1", fk)
	}
}

func TestRunLifecycle(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)

	runID := ids.NewRunID()
	run := &Run{
		ID:          runID,
		Repo:        "github.com/example/repo",
		Ref:         "refs/heads/main",
		TrustDomain: TrustDomainTrusted,
		ConfigYAML:  "version: 1\n",
	}

	initialJobs := []string{"lint", "test"}
	if err := db.CreateRun(ctx, run, initialJobs); err != nil {
		t.Fatalf("CreateRun failed: %v", err)
	}

	// Verify fetched run
	fetched, err := db.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("GetRun failed: %v", err)
	}
	if fetched.State != RunStateQueued {
		t.Errorf("run state = %s, want Queued", fetched.State)
	}
	if fetched.StartedAt != nil {
		t.Errorf("started_at should be nil initially")
	}

	// Verify initial jobs
	jobs, err := db.ListJobs(ctx, runID)
	if err != nil {
		t.Fatalf("ListJobs failed: %v", err)
	}
	if len(jobs) != 2 {
		t.Fatalf("expected 2 jobs, got %d", len(jobs))
	}
	for _, j := range jobs {
		if j.State != JobStateQueued {
			t.Errorf("job %s state = %s, want queued", j.Name, j.State)
		}
	}

	// Transition Queued -> Running
	if err := db.TransitionRun(ctx, runID, RunStateQueued, RunStateRunning, ""); err != nil {
		t.Fatalf("TransitionRun Queued->Running failed: %v", err)
	}
	runningRun, err := db.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("GetRun failed: %v", err)
	}
	if runningRun.State != RunStateRunning {
		t.Errorf("run state = %s, want Running", runningRun.State)
	}
	if runningRun.StartedAt == nil {
		t.Errorf("started_at should not be nil")
	}

	// Transition Running -> Verifying
	if err := db.TransitionRun(ctx, runID, RunStateRunning, RunStateVerifying, ""); err != nil {
		t.Fatalf("TransitionRun Running->Verifying failed: %v", err)
	}

	// Transition Verifying -> Success
	if err := db.TransitionRun(ctx, runID, RunStateVerifying, RunStateSuccess, ""); err != nil {
		t.Fatalf("TransitionRun Verifying->Success failed: %v", err)
	}
	finishedRun, err := db.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("GetRun failed: %v", err)
	}
	if finishedRun.State != RunStateSuccess {
		t.Errorf("run state = %s, want Success", finishedRun.State)
	}
	if finishedRun.FinishedAt == nil {
		t.Errorf("finished_at should not be nil")
	}
}

func TestRunInvalidTransitions(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)

	runID := ids.NewRunID()
	run := &Run{
		ID:          runID,
		Repo:        "github.com/example/repo",
		Ref:         "refs/heads/main",
		TrustDomain: TrustDomainUntrusted,
	}

	if err := db.CreateRun(ctx, run, []string{"test"}); err != nil {
		t.Fatalf("CreateRun failed: %v", err)
	}

	// Queued -> Success directly is invalid
	err := db.TransitionRun(ctx, runID, RunStateQueued, RunStateSuccess, "")
	if err == nil {
		t.Fatalf("expected error for Queued -> Success, got nil")
	}

	// Transition to Running
	if err := db.TransitionRun(ctx, runID, RunStateQueued, RunStateRunning, ""); err != nil {
		t.Fatalf("TransitionRun Queued->Running failed: %v", err)
	}

	// Transition with wrong 'from' state
	err = db.TransitionRun(ctx, runID, RunStateQueued, RunStateSuccess, "")
	if err == nil {
		t.Fatalf("expected error for mismatch from state, got nil")
	}

	// Terminate with Failed
	if err := db.TransitionRun(ctx, runID, RunStateRunning, RunStateFailed, "test failed"); err != nil {
		t.Fatalf("TransitionRun Running->Failed failed: %v", err)
	}

	// Transition from terminal state should be rejected
	err = db.TransitionRun(ctx, runID, RunStateFailed, RunStateRunning, "")
	if err == nil {
		t.Fatalf("expected error for transition from terminal state, got nil")
	}
}

func TestJobLifecycle(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)

	runID := ids.NewRunID()
	run := &Run{
		ID:          runID,
		Repo:        "github.com/example/repo",
		Ref:         "refs/heads/main",
		TrustDomain: TrustDomainLocal,
	}

	if err := db.CreateRun(ctx, run, []string{"build", "lint"}); err != nil {
		t.Fatalf("CreateRun failed: %v", err)
	}

	// Transition job: queued -> running
	if err := db.TransitionJob(ctx, runID, "build", JobStateQueued, JobStateRunning, nil, ""); err != nil {
		t.Fatalf("TransitionJob queued->running failed: %v", err)
	}

	j, err := db.GetJob(ctx, runID, "build")
	if err != nil {
		t.Fatalf("GetJob failed: %v", err)
	}
	if j.State != JobStateRunning || j.StartedAt == nil {
		t.Errorf("job state or started_at mismatch: %+v", j)
	}

	// Transition job: running -> success with exit code 0
	exit0 := 0
	if err := db.TransitionJob(ctx, runID, "build", JobStateRunning, JobStateSuccess, &exit0, ""); err != nil {
		t.Fatalf("TransitionJob running->success failed: %v", err)
	}

	j, err = db.GetJob(ctx, runID, "build")
	if err != nil {
		t.Fatalf("GetJob failed: %v", err)
	}
	if j.State != JobStateSuccess || j.FinishedAt == nil || j.ExitCode == nil || *j.ExitCode != 0 {
		t.Errorf("job state, finished_at or exit_code mismatch: %+v", j)
	}

	// Transition lint: queued -> cancelled
	if err := db.TransitionJob(ctx, runID, "lint", JobStateQueued, JobStateCancelled, nil, "superseded"); err != nil {
		t.Fatalf("TransitionJob queued->cancelled failed: %v", err)
	}

	j, err = db.GetJob(ctx, runID, "lint")
	if err != nil {
		t.Fatalf("GetJob failed: %v", err)
	}
	if j.State != JobStateCancelled || j.Error != "superseded" {
		t.Errorf("job mismatch: %+v", j)
	}
}

func TestOutboxAndHWM(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)

	runID := ids.NewRunID()
	run := &Run{
		ID:          runID,
		Repo:        "github.com/example/repo",
		Ref:         "refs/heads/main",
		TrustDomain: TrustDomainLocal,
	}

	if err := db.CreateRun(ctx, run, []string{"lint"}); err != nil {
		t.Fatalf("CreateRun failed: %v", err)
	}

	// Should have 2 outbox events: job.transition (lint: Queued) and run.transition (Queued)
	events, err := db.FetchOutbox(ctx, 0, 100)
	if err != nil {
		t.Fatalf("FetchOutbox failed: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 outbox events, got %d", len(events))
	}
	if events[0].Seq >= events[1].Seq {
		t.Errorf("expected monotonic seq, got %d and %d", events[0].Seq, events[1].Seq)
	}

	// Ack first event
	if err := db.AckOutbox(ctx, events[0].Seq); err != nil {
		t.Fatalf("AckOutbox failed: %v", err)
	}

	remaining, err := db.FetchOutbox(ctx, 0, 100)
	if err != nil {
		t.Fatalf("FetchOutbox failed: %v", err)
	}
	if len(remaining) != 1 {
		t.Fatalf("expected 1 event remaining, got %d", len(remaining))
	}
	if remaining[0].Seq != events[1].Seq {
		t.Errorf("remaining seq = %d, want %d", remaining[0].Seq, events[1].Seq)
	}

	// Verify HWM
	inSeq, outAcked, err := db.GetHWM(ctx)
	if err != nil {
		t.Fatalf("GetHWM failed: %v", err)
	}
	if inSeq != 0 {
		t.Errorf("inSeq = %d, want 0", inSeq)
	}
	if outAcked != events[0].Seq {
		t.Errorf("outAcked = %d, want %d", outAcked, events[0].Seq)
	}

	// Set incoming HWM
	if err := db.SetHWMIn(ctx, 42); err != nil {
		t.Fatalf("SetHWMIn failed: %v", err)
	}
	inSeq, _, err = db.GetHWM(ctx)
	if err != nil {
		t.Fatalf("GetHWM failed: %v", err)
	}
	if inSeq != 42 {
		t.Errorf("inSeq = %d, want 42", inSeq)
	}
}

func TestSupersedeQueuedRuns(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)

	run1 := ids.NewRunID()
	run2 := ids.NewRunID()
	run3 := ids.NewRunID()
	runOther := ids.NewRunID()

	repo := "github.com/example/repo"
	ref := "refs/heads/main"

	_ = db.CreateRun(ctx, &Run{ID: run1, Repo: repo, Ref: ref, TrustDomain: TrustDomainLocal}, nil)
	time.Sleep(10 * time.Millisecond)
	_ = db.CreateRun(ctx, &Run{ID: run2, Repo: repo, Ref: ref, TrustDomain: TrustDomainLocal}, nil)
	time.Sleep(10 * time.Millisecond)
	_ = db.CreateRun(ctx, &Run{ID: run3, Repo: repo, Ref: ref, TrustDomain: TrustDomainLocal}, nil)
	_ = db.CreateRun(ctx, &Run{ID: runOther, Repo: "other/repo", Ref: ref, TrustDomain: TrustDomainLocal}, nil)

	// Supersede queued runs on repo/ref except run3
	superseded, err := db.SupersedeQueuedRuns(ctx, repo, ref, run3)
	if err != nil {
		t.Fatalf("SupersedeQueuedRuns failed: %v", err)
	}
	if len(superseded) != 2 {
		t.Fatalf("expected 2 superseded runs, got %d", len(superseded))
	}

	r1, _ := db.GetRun(ctx, run1)
	if r1.State != RunStateSuperseded {
		t.Errorf("run1 state = %s, want Superseded", r1.State)
	}
	r2, _ := db.GetRun(ctx, run2)
	if r2.State != RunStateSuperseded {
		t.Errorf("run2 state = %s, want Superseded", r2.State)
	}
	r3, _ := db.GetRun(ctx, run3)
	if r3.State != RunStateQueued {
		t.Errorf("run3 state = %s, want Queued", r3.State)
	}
	rOther, _ := db.GetRun(ctx, runOther)
	if rOther.State != RunStateQueued {
		t.Errorf("runOther state = %s, want Queued", rOther.State)
	}
}
