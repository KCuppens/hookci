package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
)

// HWM directions.
const (
	HWMIn       = "in"
	HWMOutAcked = "out_acked"
)

// Outbox kinds written by the store. The kind is the protocol frame type.
const (
	KindEvent       = "event"
	KindJobPlanned  = "job_planned"
	KindAnnotations = "annotations"
)

// OutboxItem is one queued frame for the hub. Seq is the frame's agent_seq.
type OutboxItem struct {
	Seq       int64
	Kind      string
	Payload   []byte
	CreatedAt time.Time
}

// AppendOutbox appends payload as a frame of the given kind and returns its seq.
func (s *Store) AppendOutbox(ctx context.Context, kind string, payload []byte) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO outbox (kind, payload, created_at) VALUES (?, ?, ?)`, kind, payload, s.timestamp())
	if err != nil {
		return 0, fmt.Errorf("store: append outbox: %w", err)
	}
	return res.LastInsertId()
}

// Pending returns up to limit outbox items with seq > after in seq order.
// A limit of zero or less returns every pending item.
func (s *Store) Pending(ctx context.Context, after int64, limit int) ([]OutboxItem, error) {
	if limit <= 0 {
		limit = -1
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT seq, kind, payload, created_at FROM outbox WHERE seq > ? ORDER BY seq LIMIT ?`, after, limit)
	if err != nil {
		return nil, fmt.Errorf("store: pending outbox: %w", err)
	}
	defer rows.Close()
	var items []OutboxItem
	for rows.Next() {
		var (
			it      OutboxItem
			created string
		)
		if err := rows.Scan(&it.Seq, &it.Kind, &it.Payload, &created); err != nil {
			return nil, fmt.Errorf("store: pending outbox: %w", err)
		}
		if it.CreatedAt, err = parseTime(created); err != nil {
			return nil, err
		}
		items = append(items, it)
	}
	return items, rows.Err()
}

// Ack deletes every item with seq <= upto and raises the out_acked HWM to upto.
func (s *Store) Ack(ctx context.Context, upto int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: ack: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM outbox WHERE seq <= ?`, upto); err != nil {
		return fmt.Errorf("store: ack: %w", err)
	}
	if err := setHWM(ctx, tx, HWMOutAcked, upto); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: ack: %w", err)
	}
	return nil
}

// GetHWM returns the high-water mark for dir ("in" or "out_acked"), 0 if unset.
func (s *Store) GetHWM(ctx context.Context, dir string) (int64, error) {
	if err := checkDirection(dir); err != nil {
		return 0, err
	}
	var seq int64
	err := s.db.QueryRowContext(ctx, `SELECT seq FROM hwm WHERE direction = ?`, dir).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("store: get hwm %s: %w", dir, err)
	}
	return seq, nil
}

// SetHWM raises the high-water mark for dir to seq. Lower values are ignored.
func (s *Store) SetHWM(ctx context.Context, dir string, seq int64) error {
	return setHWM(ctx, s.db, dir, seq)
}

type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func setHWM(ctx context.Context, db execer, dir string, seq int64) error {
	if err := checkDirection(dir); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO hwm (direction, seq) VALUES (?, ?)
		 ON CONFLICT (direction) DO UPDATE SET seq = max(seq, excluded.seq)`, dir, seq); err != nil {
		return fmt.Errorf("store: set hwm %s: %w", dir, err)
	}
	return nil
}

func checkDirection(dir string) error {
	if dir != HWMIn && dir != HWMOutAcked {
		return fmt.Errorf("store: unknown hwm direction %q", dir)
	}
	return nil
}

// AppendSeqFrame appends a frame of the given kind whose agent_seq equals its
// outbox seq: build receives the seq and returns the message to marshal. It
// returns the seq.
func (s *Store) AppendSeqFrame(ctx context.Context, kind string, build func(seq int) any) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: append %s: %w", kind, err)
	}
	defer tx.Rollback()
	seq, err := s.appendSeqFrame(ctx, tx, kind, build)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("store: append %s: %w", kind, err)
	}
	return seq, nil
}

// appendEvent writes ev as an "event" frame whose agent_seq is the row's seq.
func (s *Store) appendEvent(ctx context.Context, tx *sql.Tx, ev protocol.Event) error {
	_, err := s.appendSeqFrame(ctx, tx, KindEvent, func(seq int) any {
		ev.AgentSeq = seq
		return ev
	})
	return err
}

// appendSeqFrame inserts a placeholder, reads the seq, then stores the frame
// build makes for that seq, all inside tx.
func (s *Store) appendSeqFrame(ctx context.Context, tx *sql.Tx, kind string, build func(seq int) any) (int64, error) {
	res, err := tx.ExecContext(ctx,
		`INSERT INTO outbox (kind, payload, created_at) VALUES (?, x'', ?)`, kind, s.timestamp())
	if err != nil {
		return 0, fmt.Errorf("store: append %s: %w", kind, err)
	}
	seq, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("store: append %s: %w", kind, err)
	}
	payload, err := protocol.Marshal(kind, build(int(seq)))
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE outbox SET payload = ? WHERE seq = ?`, payload, seq); err != nil {
		return 0, fmt.Errorf("store: append %s: %w", kind, err)
	}
	return seq, nil
}

// appendFrame writes msg as a frame of type kind inside tx.
func (s *Store) appendFrame(ctx context.Context, tx *sql.Tx, kind string, msg any) error {
	payload, err := protocol.Marshal(kind, msg)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO outbox (kind, payload, created_at) VALUES (?, ?, ?)`, kind, payload, s.timestamp()); err != nil {
		return fmt.Errorf("store: append %s: %w", kind, err)
	}
	return nil
}
