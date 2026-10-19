package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var (
	ErrRunNotFound   = errors.New("run not found")
	ErrConflictState = errors.New("run state does not match expected from state")
)

// Run represents a persisted run entity.
type Run struct {
	ID          string      `json:"id"`
	Repo        string      `json:"repo"`
	Ref         string      `json:"ref"`
	TrustDomain TrustDomain `json:"trust_domain"`
	State       RunState    `json:"state"`
	QueuedAt    time.Time   `json:"queued_at"`
	StartedAt   *time.Time  `json:"started_at,omitempty"`
	FinishedAt  *time.Time  `json:"finished_at,omitempty"`
	Error       string      `json:"error,omitempty"`
	ConfigYAML  string      `json:"config_yaml,omitempty"`
}

// CreateRun inserts a new run and its initial check jobs in state Queued,
// and records the initial transition in the outbox inside a single transaction.
func (db *DB) CreateRun(ctx context.Context, run *Run, initialJobs []string) error {
	if run == nil || run.ID == "" {
		return errors.New("run ID is required")
	}

	if !IsValidRunTransition("", RunStateQueued) {
		// Just ensuring valid state
	}

	run.State = RunStateQueued
	if run.QueuedAt.IsZero() {
		run.QueuedAt = time.Now().UTC()
	}

	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin create run tx: %w", err)
	}
	defer tx.Rollback()

	_, err = tx.ExecContext(ctx, `
		INSERT INTO runs (id, repo, ref, trust_domain, state, queued_at, error, config_yaml)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, run.ID, run.Repo, run.Ref, string(run.TrustDomain), string(run.State), run.QueuedAt, run.Error, run.ConfigYAML)
	if err != nil {
		return fmt.Errorf("insert run: %w", err)
	}

	for _, jobName := range initialJobs {
		jobID := fmt.Sprintf("%s:%s", run.ID, jobName)
		_, err = tx.ExecContext(ctx, `
			INSERT INTO jobs (id, run_id, name, state)
			VALUES (?, ?, ?, ?)
		`, jobID, run.ID, jobName, string(JobStateQueued))
		if err != nil {
			return fmt.Errorf("insert initial job %s: %w", jobName, err)
		}

		payload := JobTransitionPayload{
			RunID:     run.ID,
			JobName:   jobName,
			FromState: "",
			ToState:   string(JobStateQueued),
			Timestamp: run.QueuedAt,
		}
		if err := writeOutboxTx(ctx, tx, run.ID, EventJobTransition, payload); err != nil {
			return fmt.Errorf("write job outbox: %w", err)
		}
	}

	payload := RunTransitionPayload{
		RunID:     run.ID,
		Repo:      run.Repo,
		Ref:       run.Ref,
		FromState: "",
		ToState:   string(RunStateQueued),
		Timestamp: run.QueuedAt,
	}
	if err := writeOutboxTx(ctx, tx, run.ID, EventRunTransition, payload); err != nil {
		return fmt.Errorf("write run outbox: %w", err)
	}

	return tx.Commit()
}

// GetRun retrieves a run by its ID.
func (db *DB) GetRun(ctx context.Context, id string) (*Run, error) {
	row := db.sql.QueryRowContext(ctx, `
		SELECT id, repo, ref, trust_domain, state, queued_at, started_at, finished_at, error, config_yaml
		FROM runs
		WHERE id = ?
	`, id)

	var (
		r          Run
		domainStr  string
		stateStr   string
		startedAt  sql.NullTime
		finishedAt sql.NullTime
	)

	err := row.Scan(&r.ID, &r.Repo, &r.Ref, &domainStr, &stateStr, &r.QueuedAt, &startedAt, &finishedAt, &r.Error, &r.ConfigYAML)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrRunNotFound
		}
		return nil, fmt.Errorf("get run %s: %w", id, err)
	}

	r.TrustDomain = TrustDomain(domainStr)
	r.State = RunState(stateStr)
	if startedAt.Valid {
		r.StartedAt = &startedAt.Time
	}
	if finishedAt.Valid {
		r.FinishedAt = &finishedAt.Time
	}

	return &r, nil
}

// ListRuns returns recent runs ordered by queued_at desc.
func (db *DB) ListRuns(ctx context.Context, limit int) ([]*Run, error) {
	if limit <= 0 {
		limit = 50
	}

	rows, err := db.sql.QueryContext(ctx, `
		SELECT id, repo, ref, trust_domain, state, queued_at, started_at, finished_at, error, config_yaml
		FROM runs
		ORDER BY queued_at DESC
		LIMIT ?
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("list runs: %w", err)
	}
	defer rows.Close()

	var runs []*Run
	for rows.Next() {
		var (
			r          Run
			domainStr  string
			stateStr   string
			startedAt  sql.NullTime
			finishedAt sql.NullTime
		)

		if err := rows.Scan(&r.ID, &r.Repo, &r.Ref, &domainStr, &stateStr, &r.QueuedAt, &startedAt, &finishedAt, &r.Error, &r.ConfigYAML); err != nil {
			return nil, fmt.Errorf("scan run: %w", err)
		}
		r.TrustDomain = TrustDomain(domainStr)
		r.State = RunState(stateStr)
		if startedAt.Valid {
			r.StartedAt = &startedAt.Time
		}
		if finishedAt.Valid {
			r.FinishedAt = &finishedAt.Time
		}
		runs = append(runs, &r)
	}

	return runs, rows.Err()
}

// GetIncompleteRuns returns all runs currently in non-terminal active states (Running, Verifying, RollingBack).
func (db *DB) GetIncompleteRuns(ctx context.Context) ([]*Run, error) {
	rows, err := db.sql.QueryContext(ctx, `
		SELECT id, repo, ref, trust_domain, state, queued_at, started_at, finished_at, error, config_yaml
		FROM runs
		WHERE state IN ('Running', 'Verifying', 'RollingBack')
		ORDER BY queued_at ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("query incomplete runs: %w", err)
	}
	defer rows.Close()

	var runs []*Run
	for rows.Next() {
		var (
			r          Run
			domainStr  string
			stateStr   string
			startedAt  sql.NullTime
			finishedAt sql.NullTime
		)

		if err := rows.Scan(&r.ID, &r.Repo, &r.Ref, &domainStr, &stateStr, &r.QueuedAt, &startedAt, &finishedAt, &r.Error, &r.ConfigYAML); err != nil {
			return nil, fmt.Errorf("scan run: %w", err)
		}

		r.TrustDomain = TrustDomain(domainStr)
		r.State = RunState(stateStr)
		if startedAt.Valid {
			r.StartedAt = &startedAt.Time
		}
		if finishedAt.Valid {
			r.FinishedAt = &finishedAt.Time
		}

		runs = append(runs, &r)
	}

	return runs, rows.Err()
}

// TransitionRun advances the run state, enforces transition rules, updates timestamps,
// and emits an outbox transition event in the same transaction.
func (db *DB) TransitionRun(ctx context.Context, id string, from RunState, to RunState, errMsg string) error {
	if !IsValidRunTransition(from, to) {
		return &ErrInvalidTransition{Entity: "run", From: string(from), To: string(to)}
	}

	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin transition tx: %w", err)
	}
	defer tx.Rollback()

	row := tx.QueryRowContext(ctx, `
		SELECT repo, ref, state, started_at, finished_at
		FROM runs
		WHERE id = ?
	`, id)

	var (
		repo       string
		ref        string
		currState  string
		startedAt  sql.NullTime
		finishedAt sql.NullTime
	)

	if err := row.Scan(&repo, &ref, &currState, &startedAt, &finishedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrRunNotFound
		}
		return fmt.Errorf("query run %s: %w", id, err)
	}

	if RunState(currState) != from {
		return fmt.Errorf("%w: current is %s, expected %s", ErrConflictState, currState, from)
	}

	now := time.Now().UTC()
	var newStartedAt, newFinishedAt any
	if startedAt.Valid {
		newStartedAt = startedAt.Time
	} else if to == RunStateRunning {
		newStartedAt = now
	}

	if finishedAt.Valid {
		newFinishedAt = finishedAt.Time
	} else if IsRunTerminal(to) {
		newFinishedAt = now
	}

	_, err = tx.ExecContext(ctx, `
		UPDATE runs
		SET state = ?, started_at = ?, finished_at = ?, error = CASE WHEN ? != '' THEN ? ELSE error END
		WHERE id = ?
	`, string(to), newStartedAt, newFinishedAt, errMsg, errMsg, id)
	if err != nil {
		return fmt.Errorf("update run state: %w", err)
	}

	payload := RunTransitionPayload{
		RunID:     id,
		Repo:      repo,
		Ref:       ref,
		FromState: string(from),
		ToState:   string(to),
		Error:     errMsg,
		Timestamp: now,
	}
	if err := writeOutboxTx(ctx, tx, id, EventRunTransition, payload); err != nil {
		return fmt.Errorf("write run transition outbox: %w", err)
	}

	return tx.Commit()
}

// SupersedeQueuedRuns cancels and marks any Queued runs matching repo and ref as Superseded,
// excluding exceptRunID. Returns the superseded run IDs.
func (db *DB) SupersedeQueuedRuns(ctx context.Context, repo, ref, exceptRunID string) ([]string, error) {
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin supersede tx: %w", err)
	}
	defer tx.Rollback()

	rows, err := tx.QueryContext(ctx, `
		SELECT id FROM runs
		WHERE repo = ? AND ref = ? AND id != ? AND state = ?
	`, repo, ref, exceptRunID, string(RunStateQueued))
	if err != nil {
		return nil, fmt.Errorf("query superseded runs: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan superseded run id: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	for _, id := range ids {
		_, err := tx.ExecContext(ctx, `
			UPDATE runs
			SET state = ?, finished_at = ?
			WHERE id = ?
		`, string(RunStateSuperseded), now, id)
		if err != nil {
			return nil, fmt.Errorf("update superseded run %s: %w", id, err)
		}

		payload := RunTransitionPayload{
			RunID:     id,
			Repo:      repo,
			Ref:       ref,
			FromState: string(RunStateQueued),
			ToState:   string(RunStateSuperseded),
			Timestamp: now,
		}
		if err := writeOutboxTx(ctx, tx, id, EventRunTransition, payload); err != nil {
			return nil, fmt.Errorf("write outbox superseded: %w", err)
		}
	}

	return ids, tx.Commit()
}
