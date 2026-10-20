package store

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/runstats"
)

// ListFinishedRuns returns the check runs (runs) and deploy runs
// (deploy_runs) that started and then finished within [since, until],
// ordered by finish time. kind is "check", "deploy" or "" for both; repo ""
// matches every repo. A run that ended before it started (a superseded or
// cancelled queued run) has no duration and is left out. Deploy states are
// lowercased so both kinds report "success" for a successful run.
func (s *Store) ListFinishedRuns(ctx context.Context, since, until time.Time, kind, repo string) ([]runstats.RunRecord, error) {
	if kind != "" && kind != runstats.KindCheck && kind != runstats.KindDeploy {
		return nil, fmt.Errorf("store: list finished runs: unknown kind %q", kind)
	}
	var out []runstats.RunRecord
	if kind != runstats.KindDeploy {
		checks, err := s.finishedChecks(ctx, since, until, repo)
		if err != nil {
			return nil, err
		}
		out = append(out, checks...)
	}
	if kind != runstats.KindCheck {
		deploys, err := s.finishedDeploys(ctx, since, until, repo)
		if err != nil {
			return nil, err
		}
		out = append(out, deploys...)
	}
	slices.SortStableFunc(out, func(a, b runstats.RunRecord) int {
		if c := a.FinishedAt.Compare(b.FinishedAt); c != 0 {
			return c
		}
		return strings.Compare(a.RunID, b.RunID)
	})
	return out, nil
}

func (s *Store) finishedChecks(ctx context.Context, since, until time.Time, repo string) ([]runstats.RunRecord, error) {
	terminal := []RunState{RunSuccess, RunFailed, RunCancelled, RunSuperseded, RunInterrupted}
	q := `SELECT id, repo, env, sha, state, started_at, finished_at FROM runs
		WHERE kind = 'check' AND started_at IS NOT NULL AND finished_at >= ? AND finished_at <= ?
		  AND state IN (` + placeholders(len(terminal)) + `)`
	args := []any{formatTime(since), formatTime(until)}
	for _, st := range terminal {
		args = append(args, st)
	}
	if repo != "" {
		q += ` AND repo = ?`
		args = append(args, repo)
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: list finished check runs: %w", err)
	}
	defer rows.Close()
	var out []runstats.RunRecord
	for rows.Next() {
		var (
			r                 runstats.RunRecord
			started, finished string
		)
		if err := rows.Scan(&r.RunID, &r.Repo, &r.Env, &r.SHA, &r.Status, &started, &finished); err != nil {
			return nil, fmt.Errorf("store: list finished check runs: %w", err)
		}
		if r.StartedAt, err = parseTime(started); err != nil {
			return nil, err
		}
		if r.FinishedAt, err = parseTime(finished); err != nil {
			return nil, err
		}
		r.Kind = runstats.KindCheck
		r.DurationMS = r.FinishedAt.Sub(r.StartedAt).Milliseconds()
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list finished check runs: %w", err)
	}
	return out, nil
}

func (s *Store) finishedDeploys(ctx context.Context, since, until time.Time, repo string) ([]runstats.RunRecord, error) {
	q := `SELECT run_id, repo, env, sha, state, started_at, finished_at FROM deploy_runs
		WHERE started_at IS NOT NULL AND finished_at >= ? AND finished_at <= ?
		  AND state IN (` + placeholders(len(finishedDeployStates)) + `)`
	args := []any{since.UnixMilli(), until.UnixMilli()}
	for _, st := range finishedDeployStates {
		args = append(args, st)
	}
	if repo != "" {
		q += ` AND repo = ?`
		args = append(args, repo)
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: list finished deploy runs: %w", err)
	}
	defer rows.Close()
	var out []runstats.RunRecord
	for rows.Next() {
		var (
			r                 runstats.RunRecord
			started, finished sql.NullInt64
		)
		if err := rows.Scan(&r.RunID, &r.Repo, &r.Env, &r.SHA, &r.Status, &started, &finished); err != nil {
			return nil, fmt.Errorf("store: list finished deploy runs: %w", err)
		}
		r.Kind = runstats.KindDeploy
		r.Status = strings.ToLower(r.Status)
		r.StartedAt, r.FinishedAt = fromMillis(started), fromMillis(finished)
		r.DurationMS = r.FinishedAt.Sub(r.StartedAt).Milliseconds()
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list finished deploy runs: %w", err)
	}
	return out, nil
}
