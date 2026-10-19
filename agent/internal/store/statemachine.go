package store

import (
	"fmt"

	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
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
func IsRunTerminal(s protocol.RunState) bool {
	switch s {
	case protocol.RunStateSuccess,
		protocol.RunStateFailed,
		protocol.RunStateInterrupted,
		protocol.RunStateSuperseded:
		return true
	default:
		return false
	}
}

// IsJobTerminal returns true if the job state is a terminal state.
func IsJobTerminal(s protocol.JobState) bool {
	switch s {
	case protocol.JobStateSuccess,
		protocol.JobStateFailed,
		protocol.JobStateCancelled,
		protocol.JobStateSkipped:
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
func IsValidRunTransition(from, to protocol.RunState) bool {
	if from == to {
		return true
	}
	switch from {
	case protocol.RunStateQueued:
		return to == protocol.RunStateRunning ||
			to == protocol.RunStateSuperseded ||
			to == protocol.RunStateInterrupted

	case protocol.RunStateRunning:
		return to == protocol.RunStateSuccess ||
			to == protocol.RunStateFailed ||
			to == protocol.RunStateVerifying ||
			to == protocol.RunStateInterrupted

	case protocol.RunStateVerifying:
		return to == protocol.RunStateSuccess ||
			to == protocol.RunStateRollingBack ||
			to == protocol.RunStateFailed ||
			to == protocol.RunStateInterrupted

	case protocol.RunStateRollingBack:
		return to == protocol.RunStateFailed ||
			to == protocol.RunStateInterrupted

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
func IsValidJobTransition(from, to protocol.JobState) bool {
	if from == to {
		return true
	}
	switch from {
	case protocol.JobStateQueued:
		return to == protocol.JobStateRunning ||
			to == protocol.JobStateCancelled ||
			to == protocol.JobStateSkipped

	case protocol.JobStateRunning:
		return to == protocol.JobStateSuccess ||
			to == protocol.JobStateFailed ||
			to == protocol.JobStateCancelled

	default:
		// Terminal states cannot transition further
		return false
	}
}
