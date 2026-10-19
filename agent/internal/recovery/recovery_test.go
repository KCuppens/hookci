package recovery

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation/isolationtest"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
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
	fake := &execx.Fake{}
	fake.On("docker", []string{"ps"}, execx.FakeResponse{Stdout: "c1\n"})
	fake.On("docker", []string{"rm", "-f"}, execx.FakeResponse{})
	mgr := New(db, fakeIso, services.NewManager(fake), nil)

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

	// Verify service containers were listed for run1 only, then removed
	var dockerCalls []string
	for _, c := range fake.Calls {
		dockerCalls = append(dockerCalls, c.Name+" "+strings.Join(c.Args, " "))
	}
	want := []string{
		"docker ps -aq --filter name=" + services.ContainerName("01j7run1", ""),
		"docker rm -f c1",
	}
	if strings.Join(dockerCalls, "\n") != strings.Join(want, "\n") {
		t.Errorf("docker calls = %q, want %q", dockerCalls, want)
	}
}

// newRunningRuns opens a fresh store holding one Running run per id.
func newRunningRuns(t *testing.T, ctx context.Context, ids ...string) *store.DB {
	t.Helper()
	db, err := store.Open(ctx, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for _, id := range ids {
		run := &store.Run{ID: id, Repo: "owner/repo", Ref: "main", TrustDomain: protocol.TrustDomainLocal}
		if err := db.CreateRun(ctx, run, []string{"job1"}); err != nil {
			t.Fatalf("CreateRun %s: %v", id, err)
		}
		if err := db.TransitionRun(ctx, id, protocol.RunStateQueued, protocol.RunStateRunning, ""); err != nil {
			t.Fatalf("TransitionRun %s: %v", id, err)
		}
	}
	return db
}

func assertRunState(t *testing.T, ctx context.Context, db *store.DB, id string, want protocol.RunState) {
	t.Helper()
	r, err := db.GetRun(ctx, id)
	if err != nil {
		t.Fatalf("GetRun %s: %v", id, err)
	}
	if r.State != want {
		t.Errorf("run %s state = %s, want %s", id, r.State, want)
	}
}

func TestRecoverRetriesFailedServiceCleanup(t *testing.T) {
	ctx := context.Background()
	runIDs := []string{"01j7run3", "01j7run4"}
	db := newRunningRuns(t, ctx, runIDs...)

	broken := &execx.Fake{}
	broken.On("docker", []string{"ps"}, execx.FakeResponse{Code: 1, Stderr: "daemon down"})
	brokenIso := isolationtest.NewFake()
	recovered, err := New(db, brokenIso, services.NewManager(broken), nil).Recover(ctx)
	if err == nil {
		t.Fatal("expected joined cleanup error, got nil")
	}
	if len(recovered) != 0 {
		t.Fatalf("recovered = %v, want none while docker cleanup fails", recovered)
	}
	for _, id := range runIDs {
		if !strings.Contains(err.Error(), id) {
			t.Errorf("error %q does not name run %s", err, id)
		}
		assertRunState(t, ctx, db, id, protocol.RunStateRunning)
	}
	if len(brokenIso.Cleanups) != 0 {
		t.Errorf("isolation cleaned up %v for runs left active", brokenIso.Cleanups)
	}

	working := &execx.Fake{}
	working.On("docker", []string{"ps"}, execx.FakeResponse{})
	recovered, err = New(db, isolationtest.NewFake(), services.NewManager(working), nil).Recover(ctx)
	if err != nil {
		t.Fatalf("retry Recover: %v", err)
	}
	sort.Strings(recovered)
	if strings.Join(recovered, ",") != strings.Join(runIDs, ",") {
		t.Fatalf("retry recovered = %v, want %v", recovered, runIDs)
	}
	for _, id := range runIDs {
		assertRunState(t, ctx, db, id, protocol.RunStateInterrupted)
	}
}

func TestRecoverTransitionFailureKeepsCleanupErrors(t *testing.T) {
	ctx := context.Background()
	runIDs := []string{"01j7run5", "01j7run6"}
	db := newRunningRuns(t, ctx, runIDs...)

	// The first run's cleanup fails. During the second run's cleanup, another writer
	// moves that run on, so Recover's own transition hits a state conflict.
	var psCalls int
	fake := &execx.Fake{}
	fake.On("docker", []string{"ps"}, execx.FakeResponse{Fn: func(c execx.Cmd) error {
		psCalls++
		if psCalls == 1 {
			return errors.New("daemon down")
		}
		for _, id := range runIDs {
			if c.Args[len(c.Args)-1] == "name="+services.ContainerName(id, "") {
				return db.TransitionRun(ctx, id, protocol.RunStateRunning, protocol.RunStateInterrupted, "")
			}
		}
		return fmt.Errorf("unexpected ps args %v", c.Args)
	}})

	recovered, err := New(db, isolationtest.NewFake(), services.NewManager(fake), nil).Recover(ctx)
	if err == nil {
		t.Fatal("expected joined error, got nil")
	}
	if !errors.Is(err, store.ErrConflictState) {
		t.Errorf("error %v does not wrap the transition conflict", err)
	}
	for _, id := range runIDs {
		if !strings.Contains(err.Error(), id) {
			t.Errorf("error %q does not name run %s", err, id)
		}
	}
	if len(recovered) != 0 {
		t.Errorf("recovered = %v, want none", recovered)
	}
}
