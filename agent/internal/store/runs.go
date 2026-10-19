package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/ids"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
)

// Run is one persisted run.
type Run struct {
	ID          string     `json:"id"`
	Repo        string     `json:"repo"`
	SHA         string     `json:"sha"`
	Ref         string     `json:"ref"`
	Event       string     `json:"event"` // pull_request|push|retry|local
	PR          *int       `json:"pr"`
	BaseSHA     string     `json:"base_sha"`
	Attempt     int        `json:"attempt"`
	Kind        string     `json:"kind"` // check|deploy
	Env         string     `json:"env"`
	State       RunState   `json:"state"`
	TrustDomain string     `json:"trust_domain"` // "trusted:<repo>" or "untrusted:<repo>"
	TriggerID   string     `json:"trigger_id"`
	RetryOf     *string    `json:"retry_of"`
	CreatedAt   time.Time  `json:"created_at"`
	StartedAt   *time.Time `json:"started_at"`
	FinishedAt  *time.Time `json:"finished_at"`
	Reason      string     `json:"reason"`
	StepIndex   int        `json:"step_index"`
}

// RunFilter selects runs for ListRuns. Zero fields do not filter; Limit <= 0
// means no limit.
type RunFilter struct {
	Repo   string
	States []RunState
	Limit  int
}

const runColumns = `id, repo, sha, ref, event, pr, base_sha, attempt, kind, env, state,
	trust_domain, trigger_id, retry_of, created_at, started_at, finished_at, reason, step_index`

// CreateRun inserts r in state queued with its jobs in state queued, and
// appends a queued "event" and a "job_planned" frame, all in one transaction.
// Attempt 0 is stored as 1 and a zero CreatedAt as the clock's now.
func (s *Store) CreateRun(ctx context.Context, r Run, jobs []Job) error {
	if r.ID == "" {
		return errors.New("store: run id is required")
	}
	if r.State != "" && r.State != RunQueued {
		return fmt.Errorf("%w: new run %s must start queued, not %s", ErrInvalidTransition, r.ID, r.State)
	}
	for _, j := range jobs {
		if j.State != "" && j.State != JobQueued {
			return fmt.Errorf("%w: new job %s must start queued, not %s", ErrInvalidTransition, j.Name, j.State)
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: create run: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.insertRun(ctx, tx, r, jobs); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: create run: %w", err)
	}
	return nil
}

// CreateRetry creates a new attempt of the terminal run `of`: attempt + 1,
// retry_of set, every job copied in state queued. It emits the same frames as
// CreateRun.
func (s *Store) CreateRetry(ctx context.Context, of string) (Run, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, fmt.Errorf("store: create retry: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	orig, err := scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE id = ?`, of))
	if errors.Is(err, sql.ErrNoRows) {
		return Run{}, fmt.Errorf("%w: run %s", ErrNotFound, of)
	}
	if err != nil {
		return Run{}, err
	}
	if !orig.State.Terminal() {
		return Run{}, fmt.Errorf("%w: cannot retry run %s in state %s", ErrInvalidTransition, of, orig.State)
	}
	jobs, err := queryJobs(ctx, tx, of)
	if err != nil {
		return Run{}, err
	}

	now := s.now()
	retry := orig
	retry.ID = ids.NewRunIDAt(now, rand.Reader)
	retry.Attempt = orig.Attempt + 1
	retry.State = RunQueued
	retry.RetryOf = &orig.ID
	retry.CreatedAt = now
	retry.StartedAt, retry.FinishedAt = nil, nil
	retry.Reason = ""
	retry.StepIndex = 0
	if err := s.insertRun(ctx, tx, retry, jobs); err != nil {
		return Run{}, err
	}
	created, err := scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE id = ?`, retry.ID))
	if err != nil {
		return Run{}, err
	}
	if err := tx.Commit(); err != nil {
		return Run{}, fmt.Errorf("store: create retry: %w", err)
	}
	return created, nil
}

func (s *Store) insertRun(ctx context.Context, tx *sql.Tx, r Run, jobs []Job) error {
	if r.Attempt == 0 {
		r.Attempt = 1
	}
	if r.CreatedAt.IsZero() {
		r.CreatedAt = s.now()
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO runs (`+runColumns+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
		r.ID, r.Repo, r.SHA, r.Ref, r.Event, r.PR, r.BaseSHA, r.Attempt, r.Kind, r.Env, RunQueued,
		r.TrustDomain, r.TriggerID, r.RetryOf, formatTime(r.CreatedAt), r.Reason, r.StepIndex); err != nil {
		return fmt.Errorf("store: insert run %s: %w", r.ID, err)
	}
	planned := make([]protocol.JobPlannedJobsElem, 0, len(jobs))
	for _, j := range jobs {
		needs := j.Needs
		if needs == nil {
			needs = []string{}
		}
		if err := insertJob(ctx, tx, r.ID, j.Name, needs); err != nil {
			return err
		}
		planned = append(planned, protocol.JobPlannedJobsElem{Name: j.Name, Needs: needs})
	}
	if err := s.appendEvent(ctx, tx, protocol.Event{RunId: r.ID, State: protocol.EventState(RunQueued)}); err != nil {
		return err
	}
	msg := protocol.JobPlanned{RunId: r.ID, Jobs: planned}
	if r.Env != "" {
		msg.Env = &r.Env
	}
	return s.appendFrame(ctx, tx, KindJobPlanned, msg)
}

// GetRun returns the run with id, or ErrNotFound.
func (s *Store) GetRun(ctx context.Context, id string) (Run, error) {
	r, err := scanRun(s.db.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Run{}, fmt.Errorf("%w: run %s", ErrNotFound, id)
	}
	return r, err
}

// ListRuns returns runs matching f, newest first.
func (s *Store) ListRuns(ctx context.Context, f RunFilter) ([]Run, error) {
	var (
		where []string
		args  []any
	)
	if f.Repo != "" {
		where = append(where, "repo = ?")
		args = append(args, f.Repo)
	}
	if len(f.States) > 0 {
		where = append(where, "state IN ("+placeholders(len(f.States))+")")
		for _, st := range f.States {
			args = append(args, st)
		}
	}
	q := `SELECT ` + runColumns + ` FROM runs`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	q += " ORDER BY created_at DESC, id DESC LIMIT ?"
	limit := f.Limit
	if limit <= 0 {
		limit = -1
	}
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: list runs: %w", err)
	}
	defer rows.Close()
	var runs []Run
	for rows.Next() {
		r, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, r)
	}
	return runs, rows.Err()
}

// Transition moves a run from one of `from` to `to`, validates against the
// lifecycle table, sets started_at/finished_at, writes reason, and appends an
// outbox "event" row in the same transaction. Every from -> to pair must be
// allowed (ErrInvalidTransition); a run whose state is not in `from` yields
// ErrStateMismatch and a missing run ErrNotFound.
func (s *Store) Transition(ctx context.Context, runID string, from []RunState, to RunState, reason string) error {
	if len(from) == 0 {
		return fmt.Errorf("%w: run %s: no from state", ErrInvalidTransition, runID)
	}
	args := []any{to, reason}
	set := "state = ?, reason = ?"
	now := s.timestamp()
	if to == RunRunning {
		set += ", started_at = ?"
		args = append(args, now)
	}
	if to.Terminal() {
		set += ", finished_at = ?"
		args = append(args, now)
	}
	args = append(args, runID)
	for _, f := range from {
		if !validRun(f, to) {
			return fmt.Errorf("%w: run %s -> %s", ErrInvalidTransition, f, to)
		}
		args = append(args, f)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: transition run %s: %w", runID, err)
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx,
		`UPDATE runs SET `+set+` WHERE id = ? AND state IN (`+placeholders(len(from))+`)`, args...)
	if err != nil {
		return fmt.Errorf("store: transition run %s: %w", runID, err)
	}
	if err := checkUpdated(ctx, tx, res, `SELECT state FROM runs WHERE id = ?`, []any{runID}, "run "+runID, from); err != nil {
		return err
	}
	ev := protocol.Event{RunId: runID, State: protocol.EventState(to)}
	if reason != "" {
		ev.Reason = &reason
	}
	if err := s.appendEvent(ctx, tx, ev); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: transition run %s: %w", runID, err)
	}
	return nil
}

// checkUpdated turns a zero-row UPDATE into ErrNotFound or ErrStateMismatch.
func checkUpdated[S ~string](ctx context.Context, tx *sql.Tx, res sql.Result, stateQuery string, args []any, what string, from []S) error {
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: %s: %w", what, err)
	}
	if n > 0 {
		return nil
	}
	var cur string
	err = tx.QueryRowContext(ctx, stateQuery, args...).Scan(&cur)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: %s", ErrNotFound, what)
	}
	if err != nil {
		return fmt.Errorf("store: %s: %w", what, err)
	}
	return fmt.Errorf("%w: %s is %s, want one of %v", ErrStateMismatch, what, cur, from)
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanRun(row rowScanner) (Run, error) {
	var (
		r                 Run
		pr                sql.NullInt64
		retryOf           sql.NullString
		created           string
		started, finished sql.NullString
	)
	if err := row.Scan(&r.ID, &r.Repo, &r.SHA, &r.Ref, &r.Event, &pr, &r.BaseSHA, &r.Attempt, &r.Kind, &r.Env,
		&r.State, &r.TrustDomain, &r.TriggerID, &retryOf, &created, &started, &finished, &r.Reason, &r.StepIndex); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Run{}, err
		}
		return Run{}, fmt.Errorf("store: scan run: %w", err)
	}
	if pr.Valid {
		v := int(pr.Int64)
		r.PR = &v
	}
	if retryOf.Valid {
		r.RetryOf = &retryOf.String
	}
	var err error
	if r.CreatedAt, err = parseTime(created); err != nil {
		return Run{}, err
	}
	if r.StartedAt, err = parseNullTime(started); err != nil {
		return Run{}, err
	}
	if r.FinishedAt, err = parseNullTime(finished); err != nil {
		return Run{}, err
	}
	return r, nil
}
