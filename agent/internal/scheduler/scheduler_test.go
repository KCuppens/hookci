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
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func newTestDB(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

func createRun(t *testing.T, db *store.Store, runID string, jobNames ...string) {
	t.Helper()
	jobs := make([]store.Job, 0, len(jobNames))
	for _, name := range jobNames {
		jobs = append(jobs, store.Job{Name: name})
	}
	run := store.Run{
		ID: runID, Repo: "test/repo", SHA: runID, Ref: "main", Event: "local",
		Kind: "check", TrustDomain: "trusted:local/repo",
	}
	if err := db.CreateRun(context.Background(), run, jobs); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
}

func jobState(t *testing.T, db *store.Store, runID, name string) store.JobState {
	t.Helper()
	jobs, err := db.Jobs(context.Background(), runID)
	if err != nil {
		t.Fatalf("Jobs: %v", err)
	}
	for _, j := range jobs {
		if j.Name == name {
			return j.State
		}
	}
	t.Fatalf("job %s not found in run %s", name, runID)
	return ""
}

func TestDAGBuild(t *testing.T) {
	t.Run("valid dag", func(t *testing.T) {
		checks := config.ChecksJobs{
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
		checks := config.ChecksJobs{
			"unit": {Run: "npm test", Needs: []string{"nonexistent"}},
		}
		_, err := BuildDAG(checks)
		if !errors.Is(err, ErrMissingDep) {
			t.Fatalf("expected ErrMissingDep, got %v", err)
		}
	})

	t.Run("cycle detected", func(t *testing.T) {
		checks := config.ChecksJobs{
			"a": {Run: "echo a", Needs: []string{"b"}},
			"b": {Run: "echo b", Needs: []string{"a"}},
		}
		_, err := BuildDAG(checks)
		if !errors.Is(err, ErrCycleDetected) {
			t.Fatalf("expected ErrCycleDetected, got %v", err)
		}
	})

	t.Run("duplicate dependency deduplicated", func(t *testing.T) {
		checks := config.ChecksJobs{
			"lint": {Run: "npm run lint"},
			"unit": {Run: "npm test", Needs: []string{"lint", "lint"}},
		}
		dag, err := BuildDAG(checks)
		if err != nil {
			t.Fatalf("BuildDAG failed: %v", err)
		}
		deps := dag.Dependents("lint")
		if len(deps) != 1 || deps[0] != "unit" {
			t.Fatalf("expected single dependent 'unit', got %v", deps)
		}
		if len(dag.Nodes["unit"].Needs) != 1 {
			t.Fatalf("expected 1 need for unit, got %d", len(dag.Nodes["unit"].Needs))
		}
	})
}

func TestSchedulerSlotLimiter(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()

	runID := ids.NewRunID()
	checks := config.ChecksJobs{
		"job1": {Run: "sleep"},
		"job2": {Run: "sleep"},
		"job3": {Run: "sleep"},
		"job4": {Run: "sleep"},
	}

	createRun(t, db, runID, "job1", "job2", "job3", "job4")

	slots := 2
	var currentActive int32
	var maxActive int32

	runner := RunnerFunc(func(ctx context.Context, runID string, jobName string, job config.Job) JobResult {
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
	if r.State != store.RunSuccess {
		t.Errorf("run state = %s, want Success", r.State)
	}
}

func TestSchedulerDependencyOrder(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()

	runID := ids.NewRunID()
	checks := config.ChecksJobs{
		"setup_step": {Run: "echo setup"},
		"build":      {Run: "echo build", Needs: []string{"setup_step"}},
		"test":       {Run: "echo test", Needs: []string{"build"}},
	}

	createRun(t, db, runID, "setup_step", "build", "test")

	var mu sync.Mutex
	var order []string

	runner := RunnerFunc(func(ctx context.Context, runID string, jobName string, job config.Job) JobResult {
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
	checks := config.ChecksJobs{
		"lint":      {Run: "exit 1"},
		"unit":      {Run: "echo test", Needs: []string{"lint"}},
		"unrelated": {Run: "echo ok"},
	}

	createRun(t, db, runID, "lint", "unit", "unrelated")

	runner := RunnerFunc(func(ctx context.Context, runID string, jobName string, job config.Job) JobResult {
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
	if r.State != store.RunFailed {
		t.Errorf("run state = %s, want Failed", r.State)
	}

	if st := jobState(t, db, runID, "unit"); st != store.JobSkipped {
		t.Errorf("downstream unit job state = %s, want skipped", st)
	}

	if st := jobState(t, db, runID, "unrelated"); st != store.JobSuccess {
		t.Errorf("unrelated job state = %s, want success", st)
	}
}

func TestSchedulerInterrupted(t *testing.T) {
	db := newTestDB(t)
	ctx, cancel := context.WithCancel(context.Background())

	runID := ids.NewRunID()
	checks := config.ChecksJobs{
		"long1": {Run: "sleep"},
		"long2": {Run: "sleep"},
	}

	createRun(t, db, runID, "long1", "long2")

	runner := RunnerFunc(func(ctx context.Context, runID string, jobName string, job config.Job) JobResult {
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
	if r.State != store.RunInterrupted {
		t.Errorf("run state = %s, want Interrupted", r.State)
	}
}
