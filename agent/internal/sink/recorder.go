package sink

import (
	"context"
	"slices"
	"sync"
)

// Recorder keeps every emitted event in memory, for tests. It is safe for
// concurrent use.
type Recorder struct {
	mu     sync.Mutex
	events []Event
}

// Name returns "recorder".
func (r *Recorder) Name() string { return "recorder" }

// Emit records e.
func (r *Recorder) Emit(_ context.Context, e Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
	return nil
}

// Close does nothing.
func (r *Recorder) Close() error { return nil }

// Events returns a copy of the recorded events in emit order.
func (r *Recorder) Events() []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.events)
}
