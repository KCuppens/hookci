package recovery

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/isolation/isolationtest"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func TestRecoverIncompleteRuns(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := store.Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("Open db: %v", err)
	}
	defer db.Close()

	// 1. Run 1: Running
	run1 := &store.Run{
		ID:          "01j7run1",
		Repo:        "owner/repo",
		Ref:         "main",
		TrustDomain: protocol.TrustDomainLocal,
	}
	if err := db.CreateRun(ctx, run1, []string{"job1", "job2"}); err != nil {
		t.Fatalf("CreateRun run1: %v", err)
	}
	if err := db.TransitionRun(ctx, "01j7run1", protocol.RunStateQueued, protocol.RunStateRunning, ""); err != nil {
		t.Fatalf("TransitionRun run1: %v", err)
	}
	if err := db.TransitionJob(ctx, "01j7run1", "job1", protocol.JobStateQueued, protocol.JobStateRunning, nil, ""); err != nil {
		t.Fatalf("TransitionJob run1/job1: %v", err)
	}

	// 2. Run 2: Completed / Success
	run2 := &store.Run{
		ID:          "01j7run2",
		Repo:        "owner/repo",
		Ref:         "main",
		TrustDomain: protocol.TrustDomainLocal,
	}
	if err := db.CreateRun(ctx, run2, []string{"job1"}); err != nil {
		t.Fatalf("CreateRun run2: %v", err)
	}
	if err := db.TransitionRun(ctx, "01j7run2", protocol.RunStateQueued, protocol.RunStateRunning, ""); err != nil {
		t.Fatalf("TransitionRun run2: %v", err)
	}
	if err := db.TransitionJob(ctx, "01j7run2", "job1", protocol.JobStateQueued, protocol.JobStateRunning, nil, ""); err != nil {
		t.Fatalf("TransitionJob run2/job1 running: %v", err)
	}
	code := 0
	if err := db.TransitionJob(ctx, "01j7run2", "job1", protocol.JobStateRunning, protocol.JobStateSuccess, &code, ""); err != nil {
		t.Fatalf("TransitionJob run2/job1 success: %v", err)
	}
	if err := db.TransitionRun(ctx, "01j7run2", protocol.RunStateRunning, protocol.RunStateSuccess, ""); err != nil {
		t.Fatalf("TransitionRun run2 success: %v", err)
	}

	fakeIso := isolationtest.NewFake()
	mgr := New(db, fakeIso, nil, nil)

	recovered, err := mgr.Recover(ctx)
	if err != nil {
		t.Fatalf("Recover failed: %v", err)
	}

	if len(recovered) != 1 || recovered[0] != "01j7run1" {
		t.Fatalf("expected [01j7run1] recovered, got %v", recovered)
	}

	// Verify run1 is Interrupted
	r1, err := db.GetRun(ctx, "01j7run1")
	if err != nil {
		t.Fatalf("GetRun run1: %v", err)
	}
	if r1.State != protocol.RunStateInterrupted {
		t.Errorf("expected run1 state Interrupted, got %s", r1.State)
	}
	if r1.Error != InterruptedReason {
		t.Errorf("expected run1 error %q, got %q", InterruptedReason, r1.Error)
	}

	// Verify run2 stayed Success
	r2, err := db.GetRun(ctx, "01j7run2")
	if err != nil {
		t.Fatalf("GetRun run2: %v", err)
	}
	if r2.State != protocol.RunStateSuccess {
		t.Errorf("expected run2 state Success, got %s", r2.State)
	}

	// Verify isolation cleanup was called for run1
	if len(fakeIso.Cleanups) != 1 || fakeIso.Cleanups[0] != "01j7run1" {
		t.Errorf("expected isolation cleanup for [01j7run1], got %v", fakeIso.Cleanups)
	}
}
