package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
)

var (
	ErrJobNotFound = errors.New("job not found")
)

// Job represents an individual check job execution record within a run.
type Job struct {
	ID         string            `json:"id"`
	RunID      string            `json:"run_id"`
	Name       string            `json:"name"`
	State      protocol.JobState `json:"state"`
	StartedAt  *time.Time        `json:"started_at,omitempty"`
	FinishedAt *time.Time        `json:"finished_at,omitempty"`
	ExitCode   *int              `json:"exit_code,omitempty"`
	Error      string            `json:"error,omitempty"`
}

// GetJob returns a job by runID and job name.
func (db *DB) GetJob(ctx context.Context, runID, name string) (*Job, error) {
	row := db.sql.QueryRowContext(ctx, `
		SELECT id, run_id, name, state, started_at, finished_at, exit_code, error
		FROM jobs
		WHERE run_id = ? AND name = ?
	`, runID, name)

	var (
		j          Job
		stateStr   string
		startedAt  sql.NullTime
		finishedAt sql.NullTime
		exitCode   sql.NullInt32
	)

	err := row.Scan(&j.ID, &j.RunID, &j.Name, &stateStr, &startedAt, &finishedAt, &exitCode, &j.Error)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrJobNotFound
		}
		return nil, fmt.Errorf("get job %s in run %s: %w", name, runID, err)
	}

	j.State = protocol.JobState(stateStr)
	if startedAt.Valid {
		j.StartedAt = &startedAt.Time
	}
	if finishedAt.Valid {
		j.FinishedAt = &finishedAt.Time
	}
	if exitCode.Valid {
		code := int(exitCode.Int32)
		j.ExitCode = &code
	}

	return &j, nil
}

// ListJobs returns all jobs associated with a run.
func (db *DB) ListJobs(ctx context.Context, runID string) ([]*Job, error) {
	rows, err := db.sql.QueryContext(ctx, `
		SELECT id, run_id, name, state, started_at, finished_at, exit_code, error
		FROM jobs
		WHERE run_id = ?
		ORDER BY id ASC
	`, runID)
	if err != nil {
		return nil, fmt.Errorf("list jobs for run %s: %w", runID, err)
	}
	defer rows.Close()

	var jobs []*Job
	for rows.Next() {
		var (
			j          Job
			stateStr   string
			startedAt  sql.NullTime
			finishedAt sql.NullTime
			exitCode   sql.NullInt32
		)

		if err := rows.Scan(&j.ID, &j.RunID, &j.Name, &stateStr, &startedAt, &finishedAt, &exitCode, &j.Error); err != nil {
			return nil, fmt.Errorf("scan job: %w", err)
		}
		j.State = protocol.JobState(stateStr)
		if startedAt.Valid {
			j.StartedAt = &startedAt.Time
		}
		if finishedAt.Valid {
			j.FinishedAt = &finishedAt.Time
		}
		if exitCode.Valid {
			code := int(exitCode.Int32)
			j.ExitCode = &code
		}
		jobs = append(jobs, &j)
	}

	return jobs, rows.Err()
}

// TransitionJob transitions a job's state within a transaction, writes the
// transition event to the outbox, and manages exit code and timestamps.
func (db *DB) TransitionJob(ctx context.Context, runID, name string, from, to protocol.JobState, exitCode *int, errMsg string) error {
	if !IsValidJobTransition(from, to) {
		return &ErrInvalidTransition{Entity: "job", From: string(from), To: string(to)}
	}

	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin job transition tx: %w", err)
	}
	defer tx.Rollback()

	row := tx.QueryRowContext(ctx, `
		SELECT state, started_at, finished_at
		FROM jobs
		WHERE run_id = ? AND name = ?
	`, runID, name)

	var (
		currState  string
		startedAt  sql.NullTime
		finishedAt sql.NullTime
	)

	if err := row.Scan(&currState, &startedAt, &finishedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrJobNotFound
		}
		return fmt.Errorf("query job %s in run %s: %w", name, runID, err)
	}

	if protocol.JobState(currState) != from {
		return fmt.Errorf("%w: current is %s, expected %s", ErrConflictState, currState, from)
	}

	now := time.Now().UTC()
	var newStartedAt, newFinishedAt any
	if startedAt.Valid {
		newStartedAt = startedAt.Time
	} else if to == protocol.JobStateRunning {
		newStartedAt = now
	}

	if finishedAt.Valid {
		newFinishedAt = finishedAt.Time
	} else if IsJobTerminal(to) {
		newFinishedAt = now
	}

	var exitVal any
	if exitCode != nil {
		exitVal = *exitCode
	}

	_, err = tx.ExecContext(ctx, `
		UPDATE jobs
		SET state = ?, started_at = ?, finished_at = ?, exit_code = ?, error = CASE WHEN ? != '' THEN ? ELSE error END
		WHERE run_id = ? AND name = ?
	`, string(to), newStartedAt, newFinishedAt, exitVal, errMsg, errMsg, runID, name)
	if err != nil {
		return fmt.Errorf("update job state: %w", err)
	}

	payload := JobTransitionPayload{
		RunID:     runID,
		JobName:   name,
		FromState: string(from),
		ToState:   string(to),
		ExitCode:  exitCode,
		Error:     errMsg,
		Timestamp: now,
	}
	if err := writeOutboxTx(ctx, tx, runID, EventJobTransition, payload); err != nil {
		return fmt.Errorf("write job outbox event: %w", err)
	}

	return tx.Commit()
}
