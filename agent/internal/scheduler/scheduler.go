package scheduler

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// DefaultSlots returns max(1, runtime.NumCPU()/2) as per the architectural spec.
func DefaultSlots() int {
	slots := runtime.NumCPU() / 2
	if slots < 1 {
		slots = 1
	}
	return slots
}

// JobResult represents the outcome of executing an individual job.
type JobResult struct {
	ExitCode int
	Error    error
}

// JobRunner executes an individual check job.
type JobRunner interface {
	RunJob(ctx context.Context, runID string, jobName string, job config.CheckJob) JobResult
}

// RunnerFunc allows a plain function to satisfy JobRunner.
type RunnerFunc func(ctx context.Context, runID string, jobName string, job config.CheckJob) JobResult

func (f RunnerFunc) RunJob(ctx context.Context, runID string, jobName string, job config.CheckJob) JobResult {
	return f(ctx, runID, jobName, job)
}

// Options configures scheduler concurrency and behavior.
type Options struct {
	Slots int
}

// Scheduler executes a run's check jobs DAG respecting slot limits and recording transitions in store.
type Scheduler struct {
	store  *store.DB
	runner JobRunner
	slots  int
}

// New creates a new Scheduler.
func New(db *store.DB, runner JobRunner, opts Options) *Scheduler {
	slots := opts.Slots
	if slots <= 0 {
		slots = DefaultSlots()
	}
	return &Scheduler{
		store:  db,
		runner: runner,
		slots:  slots,
	}
}

// Run executes all checks in the DAG for runID, managing concurrency slots and recording state in db.
func (s *Scheduler) Run(ctx context.Context, runID string, checks config.ConfigChecks) error {
	if len(checks) == 0 {
		return nil
	}

	dag, err := BuildDAG(checks)
	if err != nil {
		return fmt.Errorf("build dag: %w", err)
	}

	// Transition run Queued -> Running
	if s.store != nil {
		if err := s.store.TransitionRun(ctx, runID, protocol.RunStateQueued, protocol.RunStateRunning, ""); err != nil {
			return fmt.Errorf("transition run to running: %w", err)
		}
	}

	// Concurrency slot limiter
	slotSem := make(chan struct{}, s.slots)

	// State tracking
	var (
		mu          sync.Mutex
		states      = make(map[string]protocol.JobState, len(checks))
		failed      = false
		remaining   = len(checks)
		cond        = sync.NewCond(&mu)
		anyFailed   = false
		interrupted = false
	)

	for name := range checks {
		states[name] = protocol.JobStateQueued
	}

	// Helper to check if a job's dependencies are all satisfied
	canRun := func(name string) bool {
		node := dag.Nodes[name]
		for _, dep := range node.Needs {
			if states[dep] != protocol.JobStateSuccess {
				return false
			}
		}
		return true
	}

	// Helper to skip dependent jobs when upstream failed
	skipDownstream := func(failedJob string) {
		var toSkip []string
		var findDeps func(string)
		findDeps = func(curr string) {
			for _, dep := range dag.Dependents(curr) {
				if states[dep] == protocol.JobStateQueued {
					states[dep] = protocol.JobStateSkipped
					toSkip = append(toSkip, dep)
					findDeps(dep)
				}
			}
		}
		findDeps(failedJob)

		for _, skipped := range toSkip {
			remaining--
			if s.store != nil {
				_ = s.store.TransitionJob(ctx, runID, skipped, protocol.JobStateQueued, protocol.JobStateSkipped, nil, "dependency failed")
			}
		}
	}

	var wg sync.WaitGroup

	// Main dispatch loop
	for {
		mu.Lock()

		// Check context cancellation
		if ctx.Err() != nil && !interrupted {
			interrupted = true
			anyFailed = true
			// Cancel all remaining queued jobs
			for name, st := range states {
				if st == protocol.JobStateQueued {
					states[name] = protocol.JobStateCancelled
					remaining--
					if s.store != nil {
						_ = s.store.TransitionJob(context.Background(), runID, name, protocol.JobStateQueued, protocol.JobStateCancelled, nil, "interrupted")
					}
				}
			}
		}

		if remaining == 0 {
			mu.Unlock()
			break
		}

		// Find any ready job
		var nextJob string
		for name, st := range states {
			if st == protocol.JobStateQueued && canRun(name) {
				nextJob = name
				break
			}
		}

		if nextJob == "" {
			// No job ready right now. If no jobs are running, deadlock or all done/skipped.
			hasRunning := false
			for _, st := range states {
				if st == protocol.JobStateRunning {
					hasRunning = true
					break
				}
			}
			if !hasRunning {
				// Nothing is running and nothing can run
				mu.Unlock()
				break
			}

			// Wait for a running job to finish
			cond.Wait()
			mu.Unlock()
			continue
		}

		// Mark job as running
		states[nextJob] = protocol.JobStateRunning
		mu.Unlock()

		// Acquire a slot (respecting context)
		select {
		case slotSem <- struct{}{}:
		case <-ctx.Done():
			mu.Lock()
			states[nextJob] = protocol.JobStateCancelled
			remaining--
			mu.Unlock()
			if s.store != nil {
				_ = s.store.TransitionJob(context.Background(), runID, nextJob, protocol.JobStateQueued, protocol.JobStateCancelled, nil, "interrupted")
			}
			continue
		}

		jobName := nextJob
		jobCfg := checks[jobName]

		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				<-slotSem
				mu.Lock()
				cond.Broadcast()
				mu.Unlock()
			}()

			// Record job transition to running in store
			if s.store != nil {
				_ = s.store.TransitionJob(ctx, runID, jobName, protocol.JobStateQueued, protocol.JobStateRunning, nil, "")
			}

			// Execute job via runner
			res := s.runner.RunJob(ctx, runID, jobName, jobCfg)

			mu.Lock()
			defer mu.Unlock()

			remaining--
			exitCode := res.ExitCode

			if res.Error != nil || res.ExitCode != 0 {
				anyFailed = true
				failed = true
				states[jobName] = protocol.JobStateFailed
				errMsg := ""
				if res.Error != nil {
					errMsg = res.Error.Error()
				}
				if s.store != nil {
					_ = s.store.TransitionJob(context.Background(), runID, jobName, protocol.JobStateRunning, protocol.JobStateFailed, &exitCode, errMsg)
				}
				skipDownstream(jobName)
			} else {
				states[jobName] = protocol.JobStateSuccess
				if s.store != nil {
					_ = s.store.TransitionJob(context.Background(), runID, jobName, protocol.JobStateRunning, protocol.JobStateSuccess, &exitCode, "")
				}
			}
		}()
	}

	wg.Wait()

	// Finalize run state in store
	if s.store != nil {
		bgCtx := context.Background()
		if interrupted || errors.Is(ctx.Err(), context.Canceled) {
			_ = s.store.TransitionRun(bgCtx, runID, protocol.RunStateRunning, protocol.RunStateInterrupted, "run interrupted")
			return ctx.Err()
		}
		if anyFailed || failed {
			_ = s.store.TransitionRun(bgCtx, runID, protocol.RunStateRunning, protocol.RunStateFailed, "one or more jobs failed")
			return errors.New("one or more jobs failed")
		}
		_ = s.store.TransitionRun(bgCtx, runID, protocol.RunStateRunning, protocol.RunStateSuccess, "")
	}

	if anyFailed {
		return errors.New("one or more jobs failed")
	}

	return nil
}
