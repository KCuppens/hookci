package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
)

// TriggerState is the agent-side state of a hub trigger.
type TriggerState string

const (
	TriggerAccepted TriggerState = "accepted" // accepted, not started yet
	TriggerRunning  TriggerState = "running"  // its run exists in the store
	TriggerRejected TriggerState = "rejected"
	TriggerDone     TriggerState = "done"
)

// Trigger is one persisted hub trigger.
type Trigger struct {
	ID        string
	RunID     string
	State     TriggerState
	CreatedAt time.Time
}

// AcceptTrigger records triggerID with runID in state accepted and appends
// its "accepted" frame in one transaction. It returns false, and changes
// nothing, when triggerID is already recorded.
func (s *Store) AcceptTrigger(ctx context.Context, triggerID, runID string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("store: accept trigger %s: %w", triggerID, err)
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO triggers (trigger_id, run_id, state, created_at) VALUES (?, ?, ?, ?)`,
		triggerID, runID, TriggerAccepted, s.now().UnixMilli())
	if err != nil {
		return false, fmt.Errorf("store: accept trigger %s: %w", triggerID, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("store: accept trigger %s: %w", triggerID, err)
	}
	if n == 0 {
		return false, nil
	}
	if err := s.appendFrame(ctx, tx, "accepted", protocol.Accepted{TriggerId: triggerID, RunId: runID}); err != nil {
		return false, fmt.Errorf("store: accept trigger %s: %w", triggerID, err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("store: accept trigger %s: %w", triggerID, err)
	}
	return true, nil
}

// RejectTrigger moves triggerID to rejected and appends its "rejected" frame
// with reason in one transaction.
func (s *Store) RejectTrigger(ctx context.Context, triggerID, reason string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: reject trigger %s: %w", triggerID, err)
	}
	defer tx.Rollback()
	if err := setTriggerState(ctx, tx, triggerID, TriggerRejected); err != nil {
		return err
	}
	if err := s.appendFrame(ctx, tx, "rejected", protocol.Rejected{TriggerId: triggerID, Reason: reason}); err != nil {
		return fmt.Errorf("store: reject trigger %s: %w", triggerID, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: reject trigger %s: %w", triggerID, err)
	}
	return nil
}

// AnswerTrigger records the final answer to a trigger that starts no checks
// run, a deploy trigger: accepted for runID when reason is empty (state
// done), else rejected with reason. The frame is appended in the same
// transaction. It returns false, and changes nothing, when triggerID is
// already recorded.
func (s *Store) AnswerTrigger(ctx context.Context, triggerID, runID, reason string) (bool, error) {
	state, kind, frame := TriggerDone, "accepted", any(protocol.Accepted{TriggerId: triggerID, RunId: runID})
	if reason != "" {
		state, kind, frame = TriggerRejected, "rejected", protocol.Rejected{TriggerId: triggerID, Reason: reason}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("store: answer trigger %s: %w", triggerID, err)
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO triggers (trigger_id, run_id, state, created_at) VALUES (?, ?, ?, ?)`,
		triggerID, runID, state, s.now().UnixMilli())
	if err != nil {
		return false, fmt.Errorf("store: answer trigger %s: %w", triggerID, err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return false, fmt.Errorf("store: answer trigger %s: %w", triggerID, err)
	} else if n == 0 {
		return false, nil
	}
	if err := s.appendFrame(ctx, tx, kind, frame); err != nil {
		return false, fmt.Errorf("store: answer trigger %s: %w", triggerID, err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("store: answer trigger %s: %w", triggerID, err)
	}
	return true, nil
}

// TriggerRecorded reports whether triggerID is already recorded.
func (s *Store) TriggerRecorded(ctx context.Context, triggerID string) (bool, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM triggers WHERE trigger_id = ?`, triggerID).Scan(&n); err != nil {
		return false, fmt.Errorf("store: trigger %s: %w", triggerID, err)
	}
	return n > 0, nil
}

// DeployRunAccepted reports whether deploy run runID was created by a deploy
// trigger the agent answered as accepted.
func (s *Store) DeployRunAccepted(ctx context.Context, runID string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM triggers t JOIN deploy_runs d ON d.run_id = t.run_id WHERE t.run_id = ? AND t.state = ?`,
		runID, TriggerDone).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("store: deploy run %s accepted: %w", runID, err)
	}
	return n > 0, nil
}

// SetTriggerState moves triggerID to state, or returns ErrNotFound.
func (s *Store) SetTriggerState(ctx context.Context, triggerID string, state TriggerState) error {
	return setTriggerState(ctx, s.db, triggerID, state)
}

func setTriggerState(ctx context.Context, db execer, triggerID string, state TriggerState) error {
	res, err := db.ExecContext(ctx, `UPDATE triggers SET state = ? WHERE trigger_id = ?`, state, triggerID)
	if err != nil {
		return fmt.Errorf("store: set trigger %s %s: %w", triggerID, state, err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return fmt.Errorf("store: set trigger %s %s: %w", triggerID, state, err)
	} else if n == 0 {
		return fmt.Errorf("store: trigger %s: %w", triggerID, ErrNotFound)
	}
	return nil
}

// ListTriggers returns the triggers in any of states, oldest first.
func (s *Store) ListTriggers(ctx context.Context, states ...TriggerState) ([]Trigger, error) {
	q := `SELECT trigger_id, run_id, state, created_at FROM triggers`
	args := make([]any, len(states))
	if len(states) > 0 {
		q += ` WHERE state IN (?` + strings.Repeat(`, ?`, len(states)-1) + `)`
		for i, st := range states {
			args[i] = st
		}
	}
	rows, err := s.db.QueryContext(ctx, q+` ORDER BY created_at, trigger_id`, args...)
	if err != nil {
		return nil, fmt.Errorf("store: list triggers: %w", err)
	}
	defer rows.Close()
	var out []Trigger
	for rows.Next() {
		var t Trigger
		var ms int64
		if err := rows.Scan(&t.ID, &t.RunID, &t.State, &ms); err != nil {
			return nil, fmt.Errorf("store: list triggers: %w", err)
		}
		t.CreatedAt = time.UnixMilli(ms).UTC()
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list triggers: %w", err)
	}
	return out, nil
}
