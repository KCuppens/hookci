package scheduler

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/ids"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func newTestDB(t *testing.T) *store.DB {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(context.Background(), filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

func TestDAGBuild(t *testing.T) {
	t.Run("valid dag", func(t *testing.T) {
		checks := config.ConfigChecks{
			"lint":      {Run: "npm run lint"},
			"typecheck": {Run: "npm run typecheck"},
			"unit":      {Run: "npm test", Needs: []string{"lint", "typecheck"}},
		}

		dag, err := BuildDAG(checks)
		if err != nil {
			t.Fatalf("BuildDAG failed: %v", err)
		}

		initial := dag.InitialReady()
		if len(initial) != 2 || initial[0] != "lint" || initial[1] != "typecheck" {
			t.Errorf("unexpected initial ready jobs: %v", initial)
		}

		deps := dag.Dependents("lint")
		if len(deps) != 1 || deps[0] != "unit" {
			t.Errorf("unexpected lint dependents: %v", deps)
		}
	})

	t.Run("missing dependency", func(t *testing.T) {
		checks := config.ConfigChecks{
			"unit": {Run: "npm test", Needs: []string{"nonexistent"}},
		}
		_, err := BuildDAG(checks)
		if !errors.Is(err, ErrMissingDep) {
			t.Fatalf("expected ErrMissingDep, got %v", err)
		}
	})

	t.Run("cycle detected", func(t *testing.T) {
		checks := config.ConfigChecks{
			"a": {Run: "echo a", Needs: []string{"b"}},
			"b": {Run: "echo b", Needs: []string{"a"}},
		}
		_, err := BuildDAG(checks)
		if !errors.Is(err, ErrCycleDetected) {
			t.Fatalf("expected ErrCycleDetected, got %v", err)
		}
	})
}

func TestSchedulerSlotLimiter(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()

	runID := ids.NewRunID()
	checks := config.ConfigChecks{
		"job1": {Run: "sleep"},
		"job2": {Run: "sleep"},
		"job3": {Run: "sleep"},
		"job4": {Run: "sleep"},
	}

	initialJobs := []string{"job1", "job2", "job3", "job4"}
	_ = db.CreateRun(ctx, &store.Run{
		ID:          runID,
		Repo:        "test/repo",
		Ref:         "main",
		TrustDomain: protocol.TrustDomainLocal,
	}, initialJobs)

	slots := 2
	var currentActive int32
	var maxActive int32

	runner := RunnerFunc(func(ctx context.Context, runID string, jobName string, job config.CheckJob) JobResult {
		active := atomic.AddInt32(&currentActive, 1)
		for {
			max := atomic.LoadInt32(&maxActive)
			if active <= max || atomic.CompareAndSwapInt32(&maxActive, max, active) {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
		atomic.AddInt32(&currentActive, -1)
		return JobResult{ExitCode: 0}
	})

	sched := New(db, runner, Options{Slots: slots})
	if err := sched.Run(ctx, runID, checks); err != nil {
		t.Fatalf("sched.Run failed: %v", err)
	}

	if maxActive > int32(slots) {
		t.Errorf("max active jobs (%d) exceeded slot cap (%d)", maxActive, slots)
	}

	r, err := db.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("GetRun failed: %v", err)
	}
	if r.State != protocol.RunStateSuccess {
		t.Errorf("run state = %s, want Success", r.State)
	}
}

func TestSchedulerDependencyOrder(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()

	runID := ids.NewRunID()
	checks := config.ConfigChecks{
		"setup_step": {Run: "echo setup"},
		"build":      {Run: "echo build", Needs: []string{"setup_step"}},
		"test":       {Run: "echo test", Needs: []string{"build"}},
	}

	_ = db.CreateRun(ctx, &store.Run{
		ID:          runID,
		Repo:        "test/repo",
		Ref:         "main",
		TrustDomain: protocol.TrustDomainLocal,
	}, []string{"setup_step", "build", "test"})

	var mu sync.Mutex
	var order []string

	runner := RunnerFunc(func(ctx context.Context, runID string, jobName string, job config.CheckJob) JobResult {
		mu.Lock()
		order = append(order, jobName)
		mu.Unlock()
		return JobResult{ExitCode: 0}
	})

	sched := New(db, runner, Options{Slots: 4})
	if err := sched.Run(ctx, runID, checks); err != nil {
		t.Fatalf("sched.Run failed: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(order) != 3 || order[0] != "setup_step" || order[1] != "build" || order[2] != "test" {
		t.Errorf("unexpected execution order: %v", order)
	}
}

func TestSchedulerFailureSkipDownstream(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()

	runID := ids.NewRunID()
	checks := config.ConfigChecks{
		"lint":      {Run: "exit 1"},
		"unit":      {Run: "echo test", Needs: []string{"lint"}},
		"unrelated": {Run: "echo ok"},
	}

	_ = db.CreateRun(ctx, &store.Run{
		ID:          runID,
		Repo:        "test/repo",
		Ref:         "main",
		TrustDomain: protocol.TrustDomainLocal,
	}, []string{"lint", "unit", "unrelated"})

	runner := RunnerFunc(func(ctx context.Context, runID string, jobName string, job config.CheckJob) JobResult {
		if jobName == "lint" {
			return JobResult{ExitCode: 1, Error: errors.New("linter failed")}
		}
		return JobResult{ExitCode: 0}
	})

	sched := New(db, runner, Options{Slots: 2})
	err := sched.Run(ctx, runID, checks)
	if err == nil {
		t.Fatalf("expected error from failed job, got nil")
	}

	r, _ := db.GetRun(ctx, runID)
	if r.State != protocol.RunStateFailed {
		t.Errorf("run state = %s, want Failed", r.State)
	}

	unitJob, _ := db.GetJob(ctx, runID, "unit")
	if unitJob.State != protocol.JobStateSkipped {
		t.Errorf("downstream unit job state = %s, want skipped", unitJob.State)
	}

	unrelatedJob, _ := db.GetJob(ctx, runID, "unrelated")
	if unrelatedJob.State != protocol.JobStateSuccess {
		t.Errorf("unrelated job state = %s, want success", unrelatedJob.State)
	}
}

func TestSchedulerInterrupted(t *testing.T) {
	db := newTestDB(t)
	ctx, cancel := context.WithCancel(context.Background())

	runID := ids.NewRunID()
	checks := config.ConfigChecks{
		"long1": {Run: "sleep"},
		"long2": {Run: "sleep"},
	}

	_ = db.CreateRun(ctx, &store.Run{
		ID:          runID,
		Repo:        "test/repo",
		Ref:         "main",
		TrustDomain: protocol.TrustDomainLocal,
	}, []string{"long1", "long2"})

	runner := RunnerFunc(func(ctx context.Context, runID string, jobName string, job config.CheckJob) JobResult {
		cancel() // Cancel context mid-job
		select {
		case <-ctx.Done():
			return JobResult{ExitCode: 130, Error: ctx.Err()}
		case <-time.After(50 * time.Millisecond):
			return JobResult{ExitCode: 0}
		}
	})

	sched := New(db, runner, Options{Slots: 1})
	err := sched.Run(ctx, runID, checks)
	if err == nil {
		t.Fatalf("expected error for interrupted run, got nil")
	}

	r, _ := db.GetRun(context.Background(), runID)
	if r.State != protocol.RunStateInterrupted {
		t.Errorf("run state = %s, want Interrupted", r.State)
	}
}
