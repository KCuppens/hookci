package store

import (
	"fmt"
)

// ErrInvalidTransition is returned when an illegal state change is attempted.
type ErrInvalidTransition struct {
	Entity string
	From   string
	To     string
}

func (e *ErrInvalidTransition) Error() string {
	return fmt.Sprintf("invalid %s state transition: %s -> %s", e.Entity, e.From, e.To)
}

// IsRunTerminal returns true if the run state is a terminal state.
func IsRunTerminal(s RunState) bool {
	switch s {
	case RunStateSuccess,
		RunStateFailed,
		RunStateInterrupted,
		RunStateSuperseded:
		return true
	default:
		return false
	}
}

// IsJobTerminal returns true if the job state is a terminal state.
func IsJobTerminal(s JobState) bool {
	switch s {
	case JobStateSuccess,
		JobStateFailed,
		JobStateCancelled,
		JobStateSkipped:
		return true
	default:
		return false
	}
}

// IsValidRunTransition checks if transitioning from 'from' to 'to' is allowed.
//
// Allowed Run State Transitions:
//
// Queued -> Running
// Queued -> Superseded
// Queued -> Interrupted
//
// Running -> Success
// Running -> Failed
// Running -> Verifying
// Running -> Interrupted
//
// Verifying -> Success
// Verifying -> RollingBack
// Verifying -> Failed
// Verifying -> Interrupted
//
// RollingBack -> Failed
// RollingBack -> Interrupted
func IsValidRunTransition(from, to RunState) bool {
	if from == to {
		return true
	}
	switch from {
	case RunStateQueued:
		return to == RunStateRunning ||
			to == RunStateSuperseded ||
			to == RunStateInterrupted

	case RunStateRunning:
		return to == RunStateSuccess ||
			to == RunStateFailed ||
			to == RunStateVerifying ||
			to == RunStateInterrupted

	case RunStateVerifying:
		return to == RunStateSuccess ||
			to == RunStateRollingBack ||
			to == RunStateFailed ||
			to == RunStateInterrupted

	case RunStateRollingBack:
		return to == RunStateFailed ||
			to == RunStateInterrupted

	default:
		// Terminal states cannot transition further
		return false
	}
}

// IsValidJobTransition checks if transitioning from 'from' to 'to' is allowed.
//
// Allowed Job State Transitions:
//
// queued -> running
// queued -> cancelled
// queued -> skipped
//
// running -> success
// running -> failed
// running -> cancelled
func IsValidJobTransition(from, to JobState) bool {
	if from == to {
		return true
	}
	switch from {
	case JobStateQueued:
		return to == JobStateRunning ||
			to == JobStateCancelled ||
			to == JobStateSkipped

	case JobStateRunning:
		return to == JobStateSuccess ||
			to == JobStateFailed ||
			to == JobStateCancelled

	default:
		// Terminal states cannot transition further
		return false
	}
}
