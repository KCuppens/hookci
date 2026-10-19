package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
)

var allRunStates = []RunState{
	RunQueued, RunRunning, RunSuccess, RunFailed, RunCancelled,
	RunSuperseded, RunInterrupted, RunVerifying, RunRollingBack,
}

var allJobStates = []JobState{
	JobQueued, JobRunning, JobSuccess, JobFailed, JobCancelled, JobSkipped, JobInterrupted,
}

func TestRunTransitionsTable(t *testing.T) {
	allowed := map[[2]RunState]bool{
		{RunQueued, RunRunning}:          true,
		{RunQueued, RunSuperseded}:       true,
		{RunQueued, RunCancelled}:        true,
		{RunRunning, RunSuccess}:         true,
		{RunRunning, RunFailed}:          true,
		{RunRunning, RunCancelled}:       true,
		{RunRunning, RunInterrupted}:     true,
		{RunRunning, RunVerifying}:       true,
		{RunVerifying, RunSuccess}:       true,
		{RunVerifying, RunRollingBack}:   true,
		{RunVerifying, RunInterrupted}:   true,
		{RunRollingBack, RunFailed}:      true,
		{RunRollingBack, RunInterrupted}: true,
	}
	s := openTestStore(t)
	ctx := context.Background()
	mustCreateRun(t, s, testRun("r1"))

	for _, from := range allRunStates {
		for _, to := range allRunStates {
			t.Run(fmt.Sprintf("%s->%s", from, to), func(t *testing.T) {
				if _, err := s.db.Exec(`UPDATE runs SET state = ? WHERE id = 'r1'`, from); err != nil {
					t.Fatalf("set state: %v", err)
				}
				clearOutbox(t, s)
				err := s.Transition(ctx, "r1", []RunState{from}, to, "")
				if allowed[[2]RunState{from, to}] {
					if err != nil {
						t.Fatalf("Transition: %v", err)
					}
					run, err := s.GetRun(ctx, "r1")
					if err != nil || run.State != to {
						t.Errorf("state = %s (%v), want %s", run.State, err, to)
					}
					if n := outboxCount(t, s); n != 1 {
						t.Errorf("outbox rows = %d, want 1", n)
					}
					return
				}
				if !errors.Is(err, ErrInvalidTransition) {
					t.Fatalf("Transition err = %v, want ErrInvalidTransition", err)
				}
				run, err := s.GetRun(ctx, "r1")
				if err != nil || run.State != from {
					t.Errorf("state = %s (%v), want unchanged %s", run.State, err, from)
				}
				if n := outboxCount(t, s); n != 0 {
					t.Errorf("outbox rows = %d, want 0", n)
				}
			})
		}
	}
}

func TestRunStateTerminal(t *testing.T) {
	terminal := map[RunState]bool{
		RunSuccess: true, RunFailed: true, RunCancelled: true, RunSuperseded: true, RunInterrupted: true,
	}
	for _, st := range allRunStates {
		if got := st.Terminal(); got != terminal[st] {
			t.Errorf("%s.Terminal() = %v, want %v", st, got, terminal[st])
		}
	}
}

func TestTransitionStateMismatch(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mustCreateRun(t, s, testRun("r1"))
	if err := s.Transition(ctx, "r1", []RunState{RunQueued}, RunRunning, ""); err != nil {
		t.Fatal(err)
	}
	clearOutbox(t, s)

	if err := s.Transition(ctx, "r1", []RunState{RunQueued}, RunCancelled, ""); !errors.Is(err, ErrStateMismatch) {
		t.Errorf("Transition from queued on running run err = %v, want ErrStateMismatch", err)
	}
	if err := s.Transition(ctx, "missing", []RunState{RunQueued}, RunRunning, ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("Transition on missing run err = %v, want ErrNotFound", err)
	}
	if err := s.Transition(ctx, "r1", []RunState{RunQueued, RunVerifying}, RunRunning, ""); !errors.Is(err, ErrInvalidTransition) {
		t.Errorf("Transition with one invalid from err = %v, want ErrInvalidTransition", err)
	}
	if n := outboxCount(t, s); n != 0 {
		t.Errorf("outbox rows = %d, want 0", n)
	}
	if err := s.Transition(ctx, "r1", []RunState{RunQueued, RunRunning}, RunCancelled, "user"); err != nil {
		t.Errorf("Transition with from set containing current state: %v", err)
	}
}

func TestJobTransitionsTable(t *testing.T) {
	allowed := map[[2]JobState]bool{
		{JobQueued, JobRunning}:      true,
		{JobQueued, JobSkipped}:      true,
		{JobQueued, JobCancelled}:    true,
		{JobQueued, JobInterrupted}:  true,
		{JobRunning, JobSuccess}:     true,
		{JobRunning, JobFailed}:      true,
		{JobRunning, JobCancelled}:   true,
		{JobRunning, JobInterrupted}: true,
	}
	s := openTestStore(t)
	ctx := context.Background()
	mustCreateRun(t, s, testRun("r1"), Job{Name: "lint"})

	for _, from := range allJobStates {
		for _, to := range allJobStates {
			t.Run(fmt.Sprintf("%s->%s", from, to), func(t *testing.T) {
				if _, err := s.db.Exec(`UPDATE jobs SET state = ? WHERE run_id = 'r1'`, from); err != nil {
					t.Fatalf("set state: %v", err)
				}
				clearOutbox(t, s)
				err := s.TransitionJob(ctx, "r1", "lint", []JobState{from}, to, JobUpdate{})
				want := 0
				if allowed[[2]JobState{from, to}] {
					want = 1
					if err != nil {
						t.Fatalf("TransitionJob: %v", err)
					}
				} else if !errors.Is(err, ErrInvalidTransition) {
					t.Fatalf("TransitionJob err = %v, want ErrInvalidTransition", err)
				}
				if n := outboxCount(t, s); n != want {
					t.Errorf("outbox rows = %d, want %d", n, want)
				}
			})
		}
	}
}

func TestJobTransitionsAndUpdate(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mustCreateRun(t, s, testRun("r1"), Job{Name: "lint"}, Job{Name: "test"})
	clearOutbox(t, s)

	if err := s.TransitionJob(ctx, "r1", "lint", []JobState{JobQueued}, JobRunning,
		JobUpdate{Unit: "zeroci-r1-lint.scope", Step: "go vet", StepIndex: 1, StepsTotal: 3}); err != nil {
		t.Fatalf("TransitionJob running: %v", err)
	}
	seq, ev := lastEvent(t, s)
	if int64(ev.AgentSeq) != seq || ev.Job == nil || *ev.Job != "lint" || ev.State != protocol.EventState(JobRunning) ||
		ev.Step == nil || *ev.Step != "go vet" || ev.StepIndex == nil || *ev.StepIndex != 1 ||
		ev.StepsTotal == nil || *ev.StepsTotal != 3 || ev.DurationMs != nil {
		t.Errorf("running event = %+v", ev)
	}

	exit, dur := 0, int64(1234)
	if err := s.TransitionJob(ctx, "r1", "lint", []JobState{JobRunning}, JobSuccess,
		JobUpdate{ExitCode: &exit, DurationMS: &dur, Tail: []string{"ignored"}}); err != nil {
		t.Fatalf("TransitionJob success: %v", err)
	}
	_, ev = lastEvent(t, s)
	if ev.DurationMs == nil || *ev.DurationMs != 1234 || ev.Tail != nil || ev.Step != nil {
		t.Errorf("success event = %+v, want duration_ms 1234 and no tail or step", ev)
	}
	jobs, err := s.Jobs(ctx, "r1")
	if err != nil {
		t.Fatalf("Jobs: %v", err)
	}
	lint := jobs[0]
	if lint.State != JobSuccess || lint.ExitCode == nil || *lint.ExitCode != 0 || lint.DurationMS == nil ||
		*lint.DurationMS != 1234 || lint.Unit != "zeroci-r1-lint.scope" || lint.StartedAt == nil || lint.FinishedAt == nil {
		t.Errorf("lint job = %+v, want success, exit 0, 1234ms, unit kept, timestamps set", lint)
	}

	tail := make([]string, 50)
	for i := range tail {
		tail[i] = fmt.Sprintf("line %d", i)
	}
	exit = 2
	if err := s.TransitionJob(ctx, "r1", "test", []JobState{JobQueued}, JobRunning, JobUpdate{}); err != nil {
		t.Fatal(err)
	}
	if err := s.TransitionJob(ctx, "r1", "test", []JobState{JobRunning}, JobFailed,
		JobUpdate{ExitCode: &exit, DurationMS: &dur, Reason: "exit status 2", Tail: tail}); err != nil {
		t.Fatalf("TransitionJob failed: %v", err)
	}
	_, ev = lastEvent(t, s)
	if len(ev.Tail) != maxTailLines || ev.Tail[0] != "line 10" || ev.Tail[maxTailLines-1] != "line 49" {
		t.Errorf("failed event tail = %d lines [%s .. %s], want last 40", len(ev.Tail), ev.Tail[0], ev.Tail[len(ev.Tail)-1])
	}
	jobs, err = s.Jobs(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if jobs[1].State != JobFailed || *jobs[1].ExitCode != 2 || jobs[1].Reason != "exit status 2" {
		t.Errorf("test job = %+v, want failed exit 2 with reason", jobs[1])
	}

	if err := s.TransitionJob(ctx, "r1", "test", []JobState{JobRunning}, JobSuccess, JobUpdate{}); !errors.Is(err, ErrStateMismatch) {
		t.Errorf("TransitionJob on failed job err = %v, want ErrStateMismatch", err)
	}
	if err := s.TransitionJob(ctx, "r1", "nope", []JobState{JobQueued}, JobRunning, JobUpdate{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("TransitionJob on missing job err = %v, want ErrNotFound", err)
	}
	if err := s.TransitionJob(ctx, "r1", "lint", nil, JobRunning, JobUpdate{}); err == nil || !strings.Contains(err.Error(), "no from state") {
		t.Errorf("TransitionJob with no from err = %v, want no from state", err)
	}
}
