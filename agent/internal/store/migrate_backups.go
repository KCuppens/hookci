package store

import (
	"context"
	"fmt"
	"time"
)

// MigrateBackup is one file a migrate.before hook wrote for a deploy run.
type MigrateBackup struct {
	ID        int64
	Repo      string
	Env       string
	RunID     string
	SHA       string
	Path      string
	CreatedAt time.Time
}

// InsertMigrateBackup records b. b.ID is ignored; the database assigns it.
func (s *Store) InsertMigrateBackup(ctx context.Context, b MigrateBackup) error {
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO migrate_backups (repo, env, run_id, sha, path, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		b.Repo, b.Env, b.RunID, b.SHA, b.Path, b.CreatedAt.UnixMilli()); err != nil {
		return fmt.Errorf("store: insert migrate backup %s: %w", b.Path, err)
	}
	return nil
}

// ListMigrateBackups returns the backups recorded for (repo, env), newest
// first.
func (s *Store) ListMigrateBackups(ctx context.Context, repo, env string) ([]MigrateBackup, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, repo, env, run_id, sha, path, created_at FROM migrate_backups
		 WHERE repo = ? AND env = ? ORDER BY created_at DESC, id DESC`, repo, env)
	if err != nil {
		return nil, fmt.Errorf("store: list migrate backups %s/%s: %w", repo, env, err)
	}
	defer rows.Close()
	var out []MigrateBackup
	for rows.Next() {
		var (
			b       MigrateBackup
			created int64
		)
		if err := rows.Scan(&b.ID, &b.Repo, &b.Env, &b.RunID, &b.SHA, &b.Path, &created); err != nil {
			return nil, fmt.Errorf("store: list migrate backups %s/%s: %w", repo, env, err)
		}
		b.CreatedAt = time.UnixMilli(created).UTC()
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list migrate backups %s/%s: %w", repo, env, err)
	}
	return out, nil
}

// DeleteMigrateBackup removes the record id. Removing the file is the
// caller's job.
func (s *Store) DeleteMigrateBackup(ctx context.Context, id int64) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM migrate_backups WHERE id = ?`, id); err != nil {
		return fmt.Errorf("store: delete migrate backup %d: %w", id, err)
	}
	return nil
}
