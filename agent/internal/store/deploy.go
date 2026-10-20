package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"
)

// Deploy run states (deploy_runs.state).
const (
	DeployQueued      = "Queued"
	DeployRunning     = "Running"
	DeployVerifying   = "Verifying"
	DeployRollingBack = "RollingBack"
	DeploySuccess     = "Success"
	DeployFailed      = "Failed"
	DeployInterrupted = "Interrupted"
	DeploySuperseded  = "Superseded"
)

// Deploy step statuses (deploy_steps.status).
const (
	StepPending = "pending"
	StepRunning = "running"
	StepDone    = "done"
	StepFailed  = "failed"
)

// Default host port range for deploy colors.
const (
	DefaultPortLo = 20000
	DefaultPortHi = 29999
)

// ErrPortsExhausted reports that every port of an allocation range is taken.
var ErrPortsExhausted = errors.New("port range exhausted")

var (
	deployStates = []string{DeployQueued, DeployRunning, DeployVerifying, DeployRollingBack,
		DeploySuccess, DeployFailed, DeployInterrupted, DeploySuperseded}
	finishedDeployStates = []string{DeploySuccess, DeployFailed, DeployInterrupted, DeploySuperseded}
)

// DeployRun is one deploy of a sha to an environment. Zero times are stored
// as NULL (CreatedAt defaults to the store clock).
type DeployRun struct {
	RunID, Repo, Env, SHA, Ref, Strategy string
	Attempt                              int
	State                                string
	PrevColor, TargetColor, Error        string
	CreatedAt, StartedAt, FinishedAt     time.Time
}

// DeployStep is the persisted progress of one strategy step.
type DeployStep struct {
	RunID                 string
	Index                 int
	Name, Status          string
	Outputs               map[string]string
	StartedAt, FinishedAt time.Time
}

// DeployState is the live state of one (repo, env).
type DeployState struct {
	Repo, Env, ActiveColor, LastSuccessSHA, LastSuccessRun string
	UpdatedAt                                              time.Time
}

const deployRunColumns = `run_id, repo, env, sha, ref, strategy, attempt, state, prev_color, target_color, error, created_at, started_at, finished_at`

// InsertDeployRun stores a new deploy run. Attempt defaults to 1.
func (s *Store) InsertDeployRun(ctx context.Context, r DeployRun) error {
	if !slices.Contains(deployStates, r.State) {
		return fmt.Errorf("store: deploy run %s: unknown state %q", r.RunID, r.State)
	}
	if r.Attempt == 0 {
		r.Attempt = 1
	}
	if r.CreatedAt.IsZero() {
		r.CreatedAt = s.now()
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO deploy_runs (`+deployRunColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.RunID, r.Repo, r.Env, r.SHA, r.Ref, r.Strategy, r.Attempt, r.State,
		nullText(r.PrevColor), nullText(r.TargetColor), nullText(r.Error),
		r.CreatedAt.UnixMilli(), nullMillis(r.StartedAt), nullMillis(r.FinishedAt)); err != nil {
		return fmt.Errorf("store: insert deploy run %s: %w", r.RunID, err)
	}
	return nil
}

// GetDeployRun returns the deploy run runID, or ErrNotFound.
func (s *Store) GetDeployRun(ctx context.Context, runID string) (DeployRun, error) {
	r, err := scanDeployRun(s.db.QueryRowContext(ctx,
		`SELECT `+deployRunColumns+` FROM deploy_runs WHERE run_id = ?`, runID))
	if errors.Is(err, sql.ErrNoRows) {
		return DeployRun{}, fmt.Errorf("store: deploy run %s: %w", runID, ErrNotFound)
	}
	if err != nil {
		return DeployRun{}, fmt.Errorf("store: deploy run %s: %w", runID, err)
	}
	return r, nil
}

// FindDeployRun returns the deploy run of exactly (repo, env, sha, attempt),
// the newest when there are several, or ErrNotFound.
func (s *Store) FindDeployRun(ctx context.Context, repo, env, sha string, attempt int) (DeployRun, error) {
	r, err := scanDeployRun(s.db.QueryRowContext(ctx,
		`SELECT `+deployRunColumns+` FROM deploy_runs WHERE repo = ? AND env = ? AND sha = ? AND attempt = ?
		 ORDER BY created_at DESC, run_id DESC LIMIT 1`, repo, env, sha, attempt))
	if errors.Is(err, sql.ErrNoRows) {
		return DeployRun{}, fmt.Errorf("store: deploy run %s/%s at %s attempt %d: %w", repo, env, sha, attempt, ErrNotFound)
	}
	if err != nil {
		return DeployRun{}, fmt.Errorf("store: deploy run %s/%s at %s attempt %d: %w", repo, env, sha, attempt, err)
	}
	return r, nil
}

// SetDeployRunState moves runID to state with error text errMsg ("" clears
// it). Running stamps started_at with at; Success, Failed, Interrupted and
// Superseded stamp finished_at; any other state clears finished_at.
func (s *Store) SetDeployRunState(ctx context.Context, runID, state, errMsg string, at time.Time) error {
	if !slices.Contains(deployStates, state) {
		return fmt.Errorf("store: deploy run %s: unknown state %q", runID, state)
	}
	var finished any
	if slices.Contains(finishedDeployStates, state) {
		finished = at.UnixMilli()
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE deploy_runs SET state = ?, error = ?, finished_at = ?,
		  started_at = CASE WHEN ? THEN ? ELSE started_at END
		 WHERE run_id = ?`,
		state, nullText(errMsg), finished, state == DeployRunning, at.UnixMilli(), runID)
	if err != nil {
		return fmt.Errorf("store: set deploy run %s state %s: %w", runID, state, err)
	}
	return requireRow(res, "deploy run "+runID)
}

// IncrementDeployAttempt adds one to the attempt of runID and returns the new
// attempt, or ErrNotFound.
func (s *Store) IncrementDeployAttempt(ctx context.Context, runID string) (int, error) {
	var attempt int
	err := s.db.QueryRowContext(ctx,
		`UPDATE deploy_runs SET attempt = attempt + 1 WHERE run_id = ? RETURNING attempt`, runID).Scan(&attempt)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("store: deploy run %s: %w", runID, ErrNotFound)
	}
	if err != nil {
		return 0, fmt.Errorf("store: increment deploy run %s attempt: %w", runID, err)
	}
	return attempt, nil
}

// ListDeployRunsInStates returns the deploy runs whose state is one of
// states, oldest first.
func (s *Store) ListDeployRunsInStates(ctx context.Context, states ...string) ([]DeployRun, error) {
	if len(states) == 0 {
		return nil, nil
	}
	args := make([]any, len(states))
	for i, st := range states {
		args[i] = st
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+deployRunColumns+` FROM deploy_runs WHERE state IN (`+placeholders(len(states))+`) ORDER BY created_at, run_id`,
		args...)
	if err != nil {
		return nil, fmt.Errorf("store: list deploy runs: %w", err)
	}
	defer rows.Close()
	var out []DeployRun
	for rows.Next() {
		r, err := scanDeployRun(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list deploy runs: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list deploy runs: %w", err)
	}
	return out, nil
}

// BeginStep records step index of runID as running with outputs before the
// step executes. Calling it again for the same step (a resumed run) resets
// the row.
func (s *Store) BeginStep(ctx context.Context, runID string, index int, name string, outputs map[string]string, at time.Time) error {
	out, err := encodeOutputs(outputs)
	if err != nil {
		return fmt.Errorf("store: begin step %s/%d: %w", runID, index, err)
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO deploy_steps (run_id, step_index, name, status, outputs, started_at, finished_at)
		 VALUES (?, ?, ?, ?, ?, ?, NULL)
		 ON CONFLICT (run_id, step_index) DO UPDATE SET
		   name = excluded.name, status = excluded.status, outputs = excluded.outputs,
		   started_at = excluded.started_at, finished_at = NULL`,
		runID, index, name, StepRunning, out, at.UnixMilli()); err != nil {
		return fmt.Errorf("store: begin step %s/%d: %w", runID, index, err)
	}
	return nil
}

// FinishStep records the final status (done or failed) and outputs of a
// begun step, or returns ErrNotFound.
func (s *Store) FinishStep(ctx context.Context, runID string, index int, status string, outputs map[string]string, at time.Time) error {
	if status != StepDone && status != StepFailed {
		return fmt.Errorf("store: finish step %s/%d: status %q is not %s or %s", runID, index, status, StepDone, StepFailed)
	}
	out, err := encodeOutputs(outputs)
	if err != nil {
		return fmt.Errorf("store: finish step %s/%d: %w", runID, index, err)
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE deploy_steps SET status = ?, outputs = ?, finished_at = ? WHERE run_id = ? AND step_index = ?`,
		status, out, at.UnixMilli(), runID, index)
	if err != nil {
		return fmt.Errorf("store: finish step %s/%d: %w", runID, index, err)
	}
	return requireRow(res, fmt.Sprintf("deploy step %s/%d", runID, index))
}

// ListSteps returns the recorded steps of runID in index order.
func (s *Store) ListSteps(ctx context.Context, runID string) ([]DeployStep, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT run_id, step_index, name, status, outputs, started_at, finished_at
		 FROM deploy_steps WHERE run_id = ? ORDER BY step_index`, runID)
	if err != nil {
		return nil, fmt.Errorf("store: list steps %s: %w", runID, err)
	}
	defer rows.Close()
	var out []DeployStep
	for rows.Next() {
		var (
			st                DeployStep
			outputs           string
			started, finished sql.NullInt64
		)
		if err := rows.Scan(&st.RunID, &st.Index, &st.Name, &st.Status, &outputs, &started, &finished); err != nil {
			return nil, fmt.Errorf("store: list steps %s: %w", runID, err)
		}
		if err := json.Unmarshal([]byte(outputs), &st.Outputs); err != nil {
			return nil, fmt.Errorf("store: step %s/%d outputs: %w", runID, st.Index, err)
		}
		st.StartedAt, st.FinishedAt = fromMillis(started), fromMillis(finished)
		out = append(out, st)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list steps %s: %w", runID, err)
	}
	return out, nil
}

// GetDeployState returns the state of (repo, env); false when none is
// recorded yet.
func (s *Store) GetDeployState(ctx context.Context, repo, env string) (DeployState, bool, error) {
	var (
		st              DeployState
		color, sha, run sql.NullString
		updated         int64
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT repo, env, active_color, last_success_sha, last_success_run, updated_at
		 FROM deploy_state WHERE repo = ? AND env = ?`, repo, env).
		Scan(&st.Repo, &st.Env, &color, &sha, &run, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return DeployState{}, false, nil
	}
	if err != nil {
		return DeployState{}, false, fmt.Errorf("store: deploy state %s/%s: %w", repo, env, err)
	}
	st.ActiveColor, st.LastSuccessSHA, st.LastSuccessRun = color.String, sha.String, run.String
	st.UpdatedAt = time.UnixMilli(updated).UTC()
	return st, true, nil
}

// SetDeployState replaces the state of (st.Repo, st.Env). A zero UpdatedAt
// uses the store clock.
func (s *Store) SetDeployState(ctx context.Context, st DeployState) error {
	if st.UpdatedAt.IsZero() {
		st.UpdatedAt = s.now()
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO deploy_state (repo, env, active_color, last_success_sha, last_success_run, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (repo, env) DO UPDATE SET
		   active_color = excluded.active_color, last_success_sha = excluded.last_success_sha,
		   last_success_run = excluded.last_success_run, updated_at = excluded.updated_at`,
		st.Repo, st.Env, nullText(st.ActiveColor), nullText(st.LastSuccessSHA), nullText(st.LastSuccessRun),
		st.UpdatedAt.UnixMilli()); err != nil {
		return fmt.Errorf("store: set deploy state %s/%s: %w", st.Repo, st.Env, err)
	}
	return nil
}

// AllocatePort returns the host port of (repo, env, color), allocating the
// lowest port in [lo, hi] not held by any (repo, env, color) on first use.
// A full range yields an error wrapping ErrPortsExhausted.
func (s *Store) AllocatePort(ctx context.Context, repo, env, color string, lo, hi int) (int, error) {
	what := fmt.Sprintf("allocate port for %s/%s %s", repo, env, color)
	if lo < 1 || hi > 65535 || lo > hi {
		return 0, fmt.Errorf("store: %s: invalid port range %d-%d", what, lo, hi)
	}
	var port int
	err := s.immediate(ctx, what, func(conn *sql.Conn) error {
		err := conn.QueryRowContext(ctx,
			`SELECT port FROM port_allocations WHERE repo = ? AND env = ? AND color = ?`, repo, env, color).Scan(&port)
		if err == nil {
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		rows, err := conn.QueryContext(ctx,
			`SELECT port FROM port_allocations WHERE port BETWEEN ? AND ? ORDER BY port`, lo, hi)
		if err != nil {
			return err
		}
		defer rows.Close()
		port = lo
		for rows.Next() {
			var taken int
			if err := rows.Scan(&taken); err != nil {
				return err
			}
			if taken != port {
				break
			}
			port++
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if port > hi {
			return fmt.Errorf("%w: %d-%d", ErrPortsExhausted, lo, hi)
		}
		_, err = conn.ExecContext(ctx,
			`INSERT INTO port_allocations (repo, env, color, port) VALUES (?, ?, ?, ?)`, repo, env, color, port)
		return err
	})
	if err != nil {
		return 0, err
	}
	return port, nil
}

// TryAcquireEnvLock makes runID the holder of the (repo, env) lock. It
// returns false when the lock is already held, also by runID itself.
func (s *Store) TryAcquireEnvLock(ctx context.Context, repo, env, runID string, at time.Time) (bool, error) {
	acquired := false
	err := s.immediate(ctx, fmt.Sprintf("acquire env lock %s/%s for %s", repo, env, runID), func(conn *sql.Conn) error {
		var n int
		if err := conn.QueryRowContext(ctx,
			`SELECT count(*) FROM env_locks WHERE repo = ? AND env = ?`, repo, env).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
		if _, err := conn.ExecContext(ctx,
			`INSERT INTO env_locks (repo, env, run_id, acquired_at) VALUES (?, ?, ?, ?)`,
			repo, env, runID, at.UnixMilli()); err != nil {
			return err
		}
		acquired = true
		return nil
	})
	if err != nil {
		return false, err
	}
	return acquired, nil
}

// ReleaseEnvLock frees the (repo, env) lock when runID holds it; otherwise
// it changes nothing.
func (s *Store) ReleaseEnvLock(ctx context.Context, repo, env, runID string) error {
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM env_locks WHERE repo = ? AND env = ? AND run_id = ?`, repo, env, runID); err != nil {
		return fmt.Errorf("store: release env lock %s/%s for %s: %w", repo, env, runID, err)
	}
	return nil
}

// EnvLockHolder returns the run holding the (repo, env) lock; false when it
// is free.
func (s *Store) EnvLockHolder(ctx context.Context, repo, env string) (string, bool, error) {
	var runID string
	err := s.db.QueryRowContext(ctx,
		`SELECT run_id FROM env_locks WHERE repo = ? AND env = ?`, repo, env).Scan(&runID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("store: env lock %s/%s: %w", repo, env, err)
	}
	return runID, true, nil
}

// immediate runs fn inside a BEGIN IMMEDIATE transaction on one connection,
// so its reads and the writes that depend on them are not interleaved with
// another writer.
func (s *Store) immediate(ctx context.Context, what string, fn func(conn *sql.Conn) error) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("store: %s: %w", what, err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		return fmt.Errorf("store: %s: %w", what, err)
	}
	if err := fn(conn); err != nil {
		_, _ = conn.ExecContext(context.WithoutCancel(ctx), `ROLLBACK`)
		return fmt.Errorf("store: %s: %w", what, err)
	}
	if _, err := conn.ExecContext(ctx, `COMMIT`); err != nil {
		_, _ = conn.ExecContext(context.WithoutCancel(ctx), `ROLLBACK`)
		return fmt.Errorf("store: %s: %w", what, err)
	}
	return nil
}

func scanDeployRun(row interface{ Scan(...any) error }) (DeployRun, error) {
	var (
		r                     DeployRun
		prev, target, errText sql.NullString
		created               int64
		started, finished     sql.NullInt64
	)
	if err := row.Scan(&r.RunID, &r.Repo, &r.Env, &r.SHA, &r.Ref, &r.Strategy, &r.Attempt, &r.State,
		&prev, &target, &errText, &created, &started, &finished); err != nil {
		return DeployRun{}, err
	}
	r.PrevColor, r.TargetColor, r.Error = prev.String, target.String, errText.String
	r.CreatedAt = time.UnixMilli(created).UTC()
	r.StartedAt, r.FinishedAt = fromMillis(started), fromMillis(finished)
	return r, nil
}

// requireRow turns a zero-row UPDATE into ErrNotFound.
func requireRow(res sql.Result, what string) error {
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: %s: %w", what, err)
	}
	if n == 0 {
		return fmt.Errorf("store: %s: %w", what, ErrNotFound)
	}
	return nil
}

func encodeOutputs(m map[string]string) (string, error) {
	if m == nil {
		return "{}", nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("encode outputs: %w", err)
	}
	return string(b), nil
}

func nullText(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func nullMillis(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UnixMilli()
}

func fromMillis(v sql.NullInt64) time.Time {
	if !v.Valid {
		return time.Time{}
	}
	return time.UnixMilli(v.Int64).UTC()
}
