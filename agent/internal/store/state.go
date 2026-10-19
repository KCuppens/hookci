package store

import "errors"

// RunState is the lifecycle state of a run.
type RunState string

const (
	RunQueued      RunState = "queued"
	RunRunning     RunState = "running"
	RunSuccess     RunState = "success"
	RunFailed      RunState = "failed"
	RunCancelled   RunState = "cancelled"
	RunSuperseded  RunState = "superseded"
	RunInterrupted RunState = "interrupted"
	RunVerifying   RunState = "verifying"    // deploy only (M2 uses it)
	RunRollingBack RunState = "rolling_back" // deploy only (M2 uses it)
)

// JobState is the lifecycle state of one job in a run.
type JobState string

const (
	JobQueued      JobState = "queued"
	JobRunning     JobState = "running"
	JobSuccess     JobState = "success"
	JobFailed      JobState = "failed"
	JobCancelled   JobState = "cancelled"
	JobSkipped     JobState = "skipped"
	JobInterrupted JobState = "interrupted"
)

var (
	ErrInvalidTransition = errors.New("invalid state transition")
	ErrNotFound          = errors.New("not found")
	ErrStateMismatch     = errors.New("current state not in expected set")
)

// runTransitions is the run lifecycle. A running PR check cancelled by a
// newer push is recorded as running -> failed with reason "superseded by <sha>".
var runTransitions = map[RunState][]RunState{
	RunQueued:      {RunRunning, RunSuperseded, RunCancelled},
	RunRunning:     {RunSuccess, RunFailed, RunCancelled, RunInterrupted, RunVerifying},
	RunVerifying:   {RunSuccess, RunRollingBack, RunInterrupted},
	RunRollingBack: {RunFailed, RunInterrupted},
}

var jobTransitions = map[JobState][]JobState{
	JobQueued:  {JobRunning, JobSkipped, JobCancelled, JobInterrupted},
	JobRunning: {JobSuccess, JobFailed, JobCancelled, JobInterrupted},
}

// Terminal reports whether no transition leaves s.
func (s RunState) Terminal() bool {
	switch s {
	case RunSuccess, RunFailed, RunCancelled, RunSuperseded, RunInterrupted:
		return true
	}
	return false
}

// Terminal reports whether no transition leaves s.
func (s JobState) Terminal() bool {
	switch s {
	case JobSuccess, JobFailed, JobCancelled, JobSkipped, JobInterrupted:
		return true
	}
	return false
}

func validRun(from, to RunState) bool {
	for _, s := range runTransitions[from] {
		if s == to {
			return true
		}
	}
	return false
}

func validJob(from, to JobState) bool {
	for _, s := range jobTransitions[from] {
		if s == to {
			return true
		}
	}
	return false
}
