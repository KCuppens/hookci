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
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation/isolationtest"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func createRun(t *testing.T, ctx context.Context, db *store.Store, id string, jobs ...string) {
	t.Helper()
	run := store.Run{
		ID: id, Repo: "owner/repo", SHA: id, Ref: "main", Event: "push",
		Kind: "check", TrustDomain: "trusted:owner/repo",
	}
	planned := make([]store.Job, 0, len(jobs))
	for _, name := range jobs {
		planned = append(planned, store.Job{Name: name})
	}
	if err := db.CreateRun(ctx, run, planned); err != nil {
		t.Fatalf("CreateRun %s: %v", id, err)
	}
	if err := db.Transition(ctx, id, []store.RunState{store.RunQueued}, store.RunRunning, ""); err != nil {
		t.Fatalf("Transition %s: %v", id, err)
	}
}

func TestRecoverIncompleteRuns(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatalf("Open db: %v", err)
	}
	defer db.Close()

	// 1. Run 1: running with job1 running and job2 queued
	createRun(t, ctx, db, "01j7run1", "job1", "job2")
	if err := db.TransitionJob(ctx, "01j7run1", "job1", []store.JobState{store.JobQueued}, store.JobRunning, store.JobUpdate{}); err != nil {
		t.Fatalf("TransitionJob run1/job1: %v", err)
	}

	// 2. Run 2: finished successfully
	createRun(t, ctx, db, "01j7run2", "job1")
	if err := db.TransitionJob(ctx, "01j7run2", "job1", []store.JobState{store.JobQueued}, store.JobRunning, store.JobUpdate{}); err != nil {
		t.Fatalf("TransitionJob run2/job1 running: %v", err)
	}
	code := 0
	if err := db.TransitionJob(ctx, "01j7run2", "job1", []store.JobState{store.JobRunning}, store.JobSuccess, store.JobUpdate{ExitCode: &code}); err != nil {
		t.Fatalf("TransitionJob run2/job1 success: %v", err)
	}
	if err := db.Transition(ctx, "01j7run2", []store.RunState{store.RunRunning}, store.RunSuccess, ""); err != nil {
		t.Fatalf("Transition run2 success: %v", err)
	}

	fakeIso := isolationtest.NewFake()
	orphan := isolation.UnitName("01j7run1", "job1")
	fakeIso.Units = []isolation.Unit{
		{Name: orphan, Active: "active"},
		{Name: isolation.UnitName("01j7run2", "job1"), Active: "active"},
	}
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
	if r1.State != store.RunInterrupted {
		t.Errorf("expected run1 state interrupted, got %s", r1.State)
	}
	if r1.Reason != InterruptedReason {
		t.Errorf("expected run1 reason %q, got %q", InterruptedReason, r1.Reason)
	}
	jobs, err := db.Jobs(ctx, "01j7run1")
	if err != nil {
		t.Fatalf("Jobs run1: %v", err)
	}
	for _, j := range jobs {
		if j.State != store.JobInterrupted || j.Reason != InterruptedReason {
			t.Errorf("run1 job %s = %s (%q), want interrupted with reason", j.Name, j.State, j.Reason)
		}
	}

	// Verify run2 stayed Success
	r2, err := db.GetRun(ctx, "01j7run2")
	if err != nil {
		t.Fatalf("GetRun run2: %v", err)
	}
	if r2.State != store.RunSuccess {
		t.Errorf("expected run2 state success, got %s", r2.State)
	}

	// Verify only run1's orphan unit was stopped
	if len(fakeIso.Stops) != 1 || fakeIso.Stops[0] != orphan {
		t.Errorf("expected isolation stop of [%s], got %v", orphan, fakeIso.Stops)
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

// newRunningRuns opens a fresh store holding one running run per id.
func newRunningRuns(t *testing.T, ctx context.Context, ids ...string) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatalf("Open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for _, id := range ids {
		createRun(t, ctx, db, id, "job1")
	}
	return db
}

func assertRunState(t *testing.T, ctx context.Context, db *store.Store, id string, want store.RunState) {
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
	brokenIso.Units = []isolation.Unit{{Name: isolation.UnitName("01j7run3", "job1"), Active: "active"}}
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
		assertRunState(t, ctx, db, id, store.RunRunning)
	}
	if len(brokenIso.Stops) != 0 {
		t.Errorf("isolation stopped %v for runs left active", brokenIso.Stops)
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
		assertRunState(t, ctx, db, id, store.RunInterrupted)
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
				return db.Transition(ctx, id, []store.RunState{store.RunRunning}, store.RunInterrupted, "")
			}
		}
		return fmt.Errorf("unexpected ps args %v", c.Args)
	}})

	recovered, err := New(db, isolationtest.NewFake(), services.NewManager(fake), nil).Recover(ctx)
	if err == nil {
		t.Fatal("expected joined error, got nil")
	}
	if !errors.Is(err, store.ErrStateMismatch) {
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
