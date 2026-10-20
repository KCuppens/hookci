// Package sink carries run and job lifecycle events out of the agent. Sinks
// are fed by Pump from the store outbox in agent_seq order, so every sink sees
// the same event stream.
package sink

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/KCuppens/hookci/agent/internal/logpipe"
)

// Kind says what an Event describes.
type Kind string

const (
	KindRun         Kind = "run"
	KindJob         Kind = "job"
	KindStep        Kind = "step"
	KindAnnotations Kind = "annotations"
)

// Event is one lifecycle event, decoded from an outbox row.
type Event struct {
	Seq         int64 // agent_seq from the outbox
	Kind        Kind
	RunID       string
	Repo        string
	SHA         string
	Job         string // empty for run events
	State       string // store.RunState or store.JobState value
	Step        string
	StepIndex   int // counts from 0, as in the protocol
	StepsTotal  int
	DurationMS  int64
	Reason      string
	Tail        []string             // <=40, already redacted
	Annotations []logpipe.Annotation // only for KindAnnotations
	// AnnotationsTotal counts the job's annotations including those left out
	// of Annotations; 0 means len(Annotations).
	AnnotationsTotal int
	At               time.Time
}

// Sink receives events. Emit may be called from several goroutines.
type Sink interface {
	Name() string
	Emit(ctx context.Context, e Event) error
	Close() error
}

// Multi fans every event out to each sink in order.
type Multi []Sink

// Name returns "multi".
func (m Multi) Name() string { return "multi" }

// Emit delivers e to every sink, even after one fails, and joins the errors.
func (m Multi) Emit(ctx context.Context, e Event) error {
	var errs []error
	for _, s := range m {
		if err := s.Emit(ctx, e); err != nil {
			errs = append(errs, fmt.Errorf("sink %s: %w", s.Name(), err))
		}
	}
	return errors.Join(errs...)
}

// Close closes every sink and joins the errors.
func (m Multi) Close() error {
	var errs []error
	for _, s := range m {
		if err := s.Close(); err != nil {
			errs = append(errs, fmt.Errorf("sink %s: %w", s.Name(), err))
		}
	}
	return errors.Join(errs...)
}

// Nop discards every event.
type Nop struct{}

// Name returns "nop".
func (Nop) Name() string { return "nop" }

// Emit discards e.
func (Nop) Emit(context.Context, Event) error { return nil }

// Close does nothing.
func (Nop) Close() error { return nil }
