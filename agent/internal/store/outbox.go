package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// Standard outbox event types.
const (
	EventRunTransition = "run.transition"
	EventJobTransition = "job.transition"
)

// OutboxEvent represents a queued transition or notification event.
type OutboxEvent struct {
	Seq       int64     `json:"seq"`
	RunID     string    `json:"run_id"`
	EventType string    `json:"event_type"`
	Payload   string    `json:"payload"`
	CreatedAt time.Time `json:"created_at"`
}

// RunTransitionPayload is the JSON payload stored for a run.transition event.
type RunTransitionPayload struct {
	RunID     string    `json:"run_id"`
	Repo      string    `json:"repo"`
	Ref       string    `json:"ref"`
	FromState string    `json:"from_state"`
	ToState   string    `json:"to_state"`
	Error     string    `json:"error,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

// JobTransitionPayload is the JSON payload stored for a job.transition event.
type JobTransitionPayload struct {
	RunID     string    `json:"run_id"`
	JobName   string    `json:"job_name"`
	FromState string    `json:"from_state"`
	ToState   string    `json:"to_state"`
	ExitCode  *int      `json:"exit_code,omitempty"`
	Error     string    `json:"error,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

func writeOutboxTx(ctx context.Context, tx *sql.Tx, runID, eventType string, payload any) error {
	var payloadStr string
	switch p := payload.(type) {
	case string:
		payloadStr = p
	case []byte:
		payloadStr = string(p)
	default:
		b, err := json.Marshal(p)
		if err != nil {
			return fmt.Errorf("marshal outbox payload: %w", err)
		}
		payloadStr = string(b)
	}

	_, err := tx.ExecContext(ctx, `
		INSERT INTO outbox (run_id, event_type, payload, created_at)
		VALUES (?, ?, ?, ?)
	`, runID, eventType, payloadStr, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("insert outbox row: %w", err)
	}
	return nil
}

// FetchOutbox returns events from the outbox with seq > afterSeq, ordered by seq asc up to limit.
func (db *DB) FetchOutbox(ctx context.Context, afterSeq int64, limit int) ([]OutboxEvent, error) {
	if limit <= 0 {
		limit = 100
	}

	rows, err := db.sql.QueryContext(ctx, `
		SELECT seq, run_id, event_type, payload, created_at
		FROM outbox
		WHERE seq > ?
		ORDER BY seq ASC
		LIMIT ?
	`, afterSeq, limit)
	if err != nil {
		return nil, fmt.Errorf("query outbox: %w", err)
	}
	defer rows.Close()

	var events []OutboxEvent
	for rows.Next() {
		var ev OutboxEvent
		if err := rows.Scan(&ev.Seq, &ev.RunID, &ev.EventType, &ev.Payload, &ev.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan outbox row: %w", err)
		}
		events = append(events, ev)
	}

	return events, rows.Err()
}

// AckOutbox acknowledges all outbox events up to and including ackSeq.
// It deletes acked rows and persists the high-water mark in meta.
func (db *DB) AckOutbox(ctx context.Context, ackSeq int64) error {
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin ack tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `DELETE FROM outbox WHERE seq <= ?`, ackSeq); err != nil {
		return fmt.Errorf("delete acked outbox: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO meta (key, value) VALUES ('hwm_out_acked', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value
		WHERE CAST(excluded.value AS INTEGER) > CAST(meta.value AS INTEGER)
	`, strconv.FormatInt(ackSeq, 10)); err != nil {
		return fmt.Errorf("update hwm_out_acked: %w", err)
	}

	return tx.Commit()
}

// GetHWM returns the incoming hub sequence and outgoing acknowledged sequence numbers.
func (db *DB) GetHWM(ctx context.Context) (inSeq int64, outAckedSeq int64, err error) {
	rows, err := db.sql.QueryContext(ctx, `SELECT key, value FROM meta WHERE key IN ('hwm_in', 'hwm_out_acked')`)
	if err != nil {
		return 0, 0, fmt.Errorf("query hwm meta: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return 0, 0, fmt.Errorf("scan hwm meta: %w", err)
		}
		n, _ := strconv.ParseInt(v, 10, 64)
		if k == "hwm_in" {
			inSeq = n
		} else if k == "hwm_out_acked" {
			outAckedSeq = n
		}
	}

	return inSeq, outAckedSeq, rows.Err()
}

// SetHWMIn records the highest sequence number seen from the hub.
func (db *DB) SetHWMIn(ctx context.Context, inSeq int64) error {
	_, err := db.sql.ExecContext(ctx, `
		INSERT INTO meta (key, value) VALUES ('hwm_in', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value
		WHERE CAST(excluded.value AS INTEGER) > CAST(meta.value AS INTEGER)
	`, strconv.FormatInt(inSeq, 10))
	if err != nil {
		return fmt.Errorf("update hwm_in: %w", err)
	}
	return nil
}
