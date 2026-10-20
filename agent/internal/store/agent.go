package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// BindAgent ties the hub session state of the store (the outbox, both
// high-water marks and the hub triggers) to agentID. When the store is bound
// to another agent it first drops that state and restarts outbox seqs at 1:
// the state belongs to the replaced agent's hub session, which the hub of a
// newly paired agent has never seen. Runs stay as local history. It reports
// whether state was dropped; binding an unbound store drops nothing.
func (s *Store) BindAgent(ctx context.Context, agentID string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("store: bind agent: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var bound string
	err = tx.QueryRowContext(ctx, `SELECT agent_id FROM agent WHERE id = 1`).Scan(&bound)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return false, fmt.Errorf("store: bind agent: %w", err)
	case bound == agentID:
		return false, nil
	}
	reset := bound != ""
	if reset {
		for _, q := range []string{
			`DELETE FROM outbox`,
			`DELETE FROM sqlite_sequence WHERE name = 'outbox'`,
			`DELETE FROM hwm`,
			`DELETE FROM triggers`,
		} {
			if _, err := tx.ExecContext(ctx, q); err != nil {
				return false, fmt.Errorf("store: bind agent: %w", err)
			}
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO agent (id, agent_id) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET agent_id = excluded.agent_id`, agentID); err != nil {
		return false, fmt.Errorf("store: bind agent: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("store: bind agent: %w", err)
	}
	return reset, nil
}
