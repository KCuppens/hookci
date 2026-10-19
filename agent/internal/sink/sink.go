package sink

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// Sink defines the destination interface for consuming state transitions and outbox events.
type Sink interface {
	Emit(ctx context.Context, ev store.OutboxEvent) error
	Drain(ctx context.Context, db *store.DB) error
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

// Emit formats and writes a single outbox event to the output writer.
func (s *StdoutSink) Emit(ctx context.Context, ev store.OutboxEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var line string
	switch ev.EventType {
	case store.EventRunTransition:
		var p store.RunTransitionPayload
		if err := json.Unmarshal([]byte(ev.Payload), &p); err == nil {
			errStr := ""
			if p.Error != "" {
				errStr = fmt.Sprintf(" error=%q", p.Error)
			}
			line = fmt.Sprintf("[run %s] %s -> %s (repo=%s ref=%s)%s\n",
				p.RunID, p.FromState, p.ToState, p.Repo, p.Ref, errStr)
		} else {
			line = fmt.Sprintf("[run %s] %s: %s\n", ev.RunID, ev.EventType, ev.Payload)
		}

	case store.EventJobTransition:
		var p store.JobTransitionPayload
		if err := json.Unmarshal([]byte(ev.Payload), &p); err == nil {
			statusStr := ""
			if p.ExitCode != nil {
				statusStr = fmt.Sprintf(" exit_code=%d", *p.ExitCode)
			}
			if p.Error != "" {
				statusStr += fmt.Sprintf(" error=%q", p.Error)
			}
			line = fmt.Sprintf("[job %s/%s] %s -> %s%s\n",
				p.RunID, p.JobName, p.FromState, p.ToState, statusStr)
		} else {
			line = fmt.Sprintf("[job %s] %s: %s\n", ev.RunID, ev.EventType, ev.Payload)
		}

	default:
		line = fmt.Sprintf("[%s seq=%d] run=%s payload=%s\n",
			ev.EventType, ev.Seq, ev.RunID, ev.Payload)
	}

	_, err := io.WriteString(s.writer, line)
	return err
}

// DrainOnce fetches unacked events from the SQLite outbox, emits them to the sink,
// and acknowledges them in the database. Returns count of events processed.
func (s *StdoutSink) DrainOnce(ctx context.Context, db *store.DB) (int, error) {
	events, err := db.FetchOutbox(ctx, 0, 100)
	if err != nil {
		return 0, fmt.Errorf("fetch outbox: %w", err)
	}
	if len(events) == 0 {
		return 0, nil
	}

	var lastSeq int64
	for _, ev := range events {
		if err := s.Emit(ctx, ev); err != nil {
			return 0, fmt.Errorf("emit event seq %d: %w", ev.Seq, err)
		}
		if ev.Seq > lastSeq {
			lastSeq = ev.Seq
		}
	}

	if lastSeq > 0 {
		if err := db.AckOutbox(ctx, lastSeq); err != nil {
			return len(events), fmt.Errorf("ack outbox seq %d: %w", lastSeq, err)
		}
	}

	return len(events), nil
}

// Drain drains all currently pending outbox rows until empty.
func (s *StdoutSink) Drain(ctx context.Context, db *store.DB) error {
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
func (s *StdoutSink) DrainLoop(ctx context.Context, db *store.DB, interval time.Duration) error {
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
