package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/KCuppens/hookci/agent/internal/protocol"
)

// maxTailLines caps the log tail carried by a failed job's event.
const maxTailLines = 40

// Job is one persisted job of a run.
type Job struct {
	RunID      string     `json:"run_id"`
	Name       string     `json:"name"`
	State      JobState   `json:"state"`
	Needs      []string   `json:"needs"`
	ExitCode   *int       `json:"exit_code"`
	StartedAt  *time.Time `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	DurationMS *int64     `json:"duration_ms"`
	Unit       string     `json:"unit"`
	Reason     string     `json:"reason"`
}

// JobUpdate carries the columns and event fields TransitionJob records.
// ExitCode, DurationMS, Unit and Reason are stored when set. Tail is sent
// only on failure, trimmed to its last 40 lines. Step is sent when set, and
// StepIndex/StepsTotal when StepsTotal > 0. LogsLocal marks a terminal event
// `logs: local` and drops Tail, since the log stays on the agent.
type JobUpdate struct {
	ExitCode   *int
	DurationMS *int64
	Unit       string
	Reason     string
	Tail       []string
	Step       string
	StepIndex  int
	StepsTotal int
	LogsLocal  bool
}

const jobColumns = `run_id, name, state, needs, exit_code, started_at, finished_at, duration_ms, unit, reason`

// Jobs returns the jobs of runID in creation order.
func (s *Store) Jobs(ctx context.Context, runID string) ([]Job, error) {
	return queryJobs(ctx, s.db, runID)
}

// TransitionJob moves job from one of `from` to `to` with the same rules and
// errors as Transition, records u, and appends an outbox "event" row in the
// same transaction.
func (s *Store) TransitionJob(ctx context.Context, runID, job string, from []JobState, to JobState, u JobUpdate) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: transition job %s/%s: %w", runID, job, err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.transitionJob(ctx, tx, runID, job, from, to, u); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: transition job %s/%s: %w", runID, job, err)
	}
	return nil
}

// transitionJob is TransitionJob inside the caller's transaction.
func (s *Store) transitionJob(ctx context.Context, tx *sql.Tx, runID, job string, from []JobState, to JobState, u JobUpdate) error {
	what := "job " + runID + "/" + job
	if len(from) == 0 {
		return fmt.Errorf("%w: %s: no from state", ErrInvalidTransition, what)
	}
	now := s.timestamp()
	set := "state = ?, exit_code = coalesce(?, exit_code), duration_ms = coalesce(?, duration_ms)," +
		" unit = CASE WHEN ? = '' THEN unit ELSE ? END, reason = CASE WHEN ? = '' THEN reason ELSE ? END"
	args := []any{to, u.ExitCode, u.DurationMS, u.Unit, u.Unit, u.Reason, u.Reason}
	if to == JobRunning {
		set += ", started_at = ?"
		args = append(args, now)
	}
	if to.Terminal() {
		set += ", finished_at = ?"
		args = append(args, now)
	}
	args = append(args, runID, job)
	for _, f := range from {
		if !validJob(f, to) {
			return fmt.Errorf("%w: job %s -> %s", ErrInvalidTransition, f, to)
		}
		args = append(args, f)
	}
	res, err := tx.ExecContext(ctx,
		`UPDATE jobs SET `+set+` WHERE run_id = ? AND name = ? AND state IN (`+placeholders(len(from))+`)`, args...)
	if err != nil {
		return fmt.Errorf("store: transition %s: %w", what, err)
	}
	if err := checkUpdated(ctx, tx, res, `SELECT state FROM jobs WHERE run_id = ? AND name = ?`, []any{runID, job}, what, from); err != nil {
		return err
	}
	return s.appendEvent(ctx, tx, jobEvent(runID, job, to, u))
}

func jobEvent(runID, job string, to JobState, u JobUpdate) protocol.Event {
	ev := protocol.Event{RunId: runID, Job: &job, State: protocol.EventState(to)}
	if u.DurationMS != nil {
		d := int(*u.DurationMS)
		ev.DurationMs = &d
	}
	switch {
	case u.LogsLocal && to.Terminal():
		local := protocol.EventLogsLocal
		ev.Logs = &local
	case to == JobFailed && len(u.Tail) > 0:
		tail := u.Tail
		if len(tail) > maxTailLines {
			tail = tail[len(tail)-maxTailLines:]
		}
		ev.Tail = tail
	}
	if u.Step != "" {
		ev.Step = &u.Step
	}
	if u.StepsTotal > 0 {
		ev.StepIndex = &u.StepIndex
		ev.StepsTotal = &u.StepsTotal
	}
	return ev
}

func insertJob(ctx context.Context, tx *sql.Tx, runID, name string, needs []string) error {
	enc, err := json.Marshal(needs)
	if err != nil {
		return fmt.Errorf("store: encode needs of job %s: %w", name, err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO jobs (run_id, name, state, needs) VALUES (?, ?, ?, ?)`, runID, name, JobQueued, string(enc)); err != nil {
		return fmt.Errorf("store: insert job %s/%s: %w", runID, name, err)
	}
	return nil
}

type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func queryJobs(ctx context.Context, db querier, runID string) ([]Job, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+jobColumns+` FROM jobs WHERE run_id = ? ORDER BY rowid`, runID)
	if err != nil {
		return nil, fmt.Errorf("store: jobs of %s: %w", runID, err)
	}
	defer rows.Close()
	var jobs []Job
	for rows.Next() {
		var (
			j                 Job
			needs             string
			exit, duration    sql.NullInt64
			started, finished sql.NullString
		)
		if err := rows.Scan(&j.RunID, &j.Name, &j.State, &needs, &exit, &started, &finished, &duration, &j.Unit, &j.Reason); err != nil {
			return nil, fmt.Errorf("store: scan job: %w", err)
		}
		if err := json.Unmarshal([]byte(needs), &j.Needs); err != nil {
			return nil, fmt.Errorf("store: decode needs of job %s: %w", j.Name, err)
		}
		if exit.Valid {
			v := int(exit.Int64)
			j.ExitCode = &v
		}
		if duration.Valid {
			j.DurationMS = &duration.Int64
		}
		if j.StartedAt, err = parseNullTime(started); err != nil {
			return nil, err
		}
		if j.FinishedAt, err = parseNullTime(finished); err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}
