package sink

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// Sink defines the destination interface for consuming state transitions and outbox events.
type Sink interface {
	Emit(ctx context.Context, it store.OutboxItem) error
	Drain(ctx context.Context, db *store.Store) error
	Close() error
}

// StdoutSink writes formatted state machine transitions to an output stream (e.g. stdout).
type StdoutSink struct {
	mu     sync.Mutex
	writer io.Writer
}

// NewStdout constructs a StdoutSink directing output to w (defaults to os.Stdout if nil).
func NewStdout(w io.Writer) *StdoutSink {
	if w == nil {
		w = os.Stdout
	}
	return &StdoutSink{writer: w}
}

// Emit formats and writes a single outbox frame to the output writer.
func (s *StdoutSink) Emit(ctx context.Context, it store.OutboxItem) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := io.WriteString(s.writer, formatItem(it))
	return err
}

func formatItem(it store.OutboxItem) string {
	switch it.Kind {
	case store.KindEvent:
		var ev protocol.Event
		if err := protocol.Unmarshal(it.Payload, &ev); err != nil {
			break
		}
		var detail string
		if ev.DurationMs != nil {
			detail += fmt.Sprintf(" duration_ms=%d", *ev.DurationMs)
		}
		if ev.Reason != nil {
			detail += fmt.Sprintf(" reason=%q", *ev.Reason)
		}
		if ev.Job != nil {
			return fmt.Sprintf("[job %s/%s] %s%s\n", ev.RunId, *ev.Job, ev.State, detail)
		}
		return fmt.Sprintf("[run %s] %s%s\n", ev.RunId, ev.State, detail)
	case store.KindJobPlanned:
		var plan protocol.JobPlanned
		if err := protocol.Unmarshal(it.Payload, &plan); err != nil {
			break
		}
		names := make([]string, 0, len(plan.Jobs))
		for _, j := range plan.Jobs {
			names = append(names, j.Name)
		}
		return fmt.Sprintf("[run %s] planned %s\n", plan.RunId, strings.Join(names, ", "))
	}
	return fmt.Sprintf("[%s seq=%d] %s\n", it.Kind, it.Seq, it.Payload)
}

// DrainOnce fetches pending frames from the SQLite outbox, emits them to the sink,
// and acknowledges them in the database. Returns count of frames processed.
func (s *StdoutSink) DrainOnce(ctx context.Context, db *store.Store) (int, error) {
	items, err := db.Pending(ctx, 0, 100)
	if err != nil {
		return 0, fmt.Errorf("fetch outbox: %w", err)
	}
	if len(items) == 0 {
		return 0, nil
	}

	for _, it := range items {
		if err := s.Emit(ctx, it); err != nil {
			return 0, fmt.Errorf("emit outbox seq %d: %w", it.Seq, err)
		}
	}

	lastSeq := items[len(items)-1].Seq
	if err := db.Ack(ctx, lastSeq); err != nil {
		return len(items), fmt.Errorf("ack outbox seq %d: %w", lastSeq, err)
	}
	return len(items), nil
}

// Drain drains all currently pending outbox rows until empty.
func (s *StdoutSink) Drain(ctx context.Context, db *store.Store) error {
	for {
		count, err := s.DrainOnce(ctx, db)
		if err != nil {
			return err
		}
		if count == 0 {
			return nil
		}
	}
}

// DrainLoop runs Drain at regular intervals until ctx is cancelled.
func (s *StdoutSink) DrainLoop(ctx context.Context, db *store.Store, interval time.Duration) error {
	if interval <= 0 {
		interval = 50 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		_ = s.Drain(ctx, db)
		select {
		case <-ctx.Done():
			// Final drain before exiting
			_ = s.Drain(context.Background(), db)
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// Close flushes or cleans up sink resources.
func (s *StdoutSink) Close() error {
	if closer, ok := s.writer.(io.Closer); ok && s.writer != os.Stdout && s.writer != os.Stderr {
		return closer.Close()
	}
	return nil
}
