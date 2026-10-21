package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"time"
)

// RepoConfig is the fork policy of a repository's .hookci.yml as the last
// default-branch run saw it.
type RepoConfig struct {
	Repo           string
	SHA            string
	Trust          string
	HasDeployments bool
	SeenAt         time.Time
}

// SaveRepoConfig records what the .hookci.yml of repo at sha declares,
// replacing what an earlier run of repo saw.
func (s *Store) SaveRepoConfig(ctx context.Context, repo, sha, trust string, hasDeployments bool) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO repo_config_seen (repo, sha, trust, has_deployments, seen_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (repo) DO UPDATE SET sha = excluded.sha, trust = excluded.trust,
			has_deployments = excluded.has_deployments, seen_at = excluded.seen_at`,
		repo, sha, trust, hasDeployments, s.now().UnixMilli())
	if err != nil {
		return fmt.Errorf("store: save repo config %s: %w", repo, err)
	}
	return nil
}

// ReadRepoConfigs returns the repo configs recorded in the database at path,
// ordered by repo. It opens the database read-only and never creates or
// migrates it, so a missing database, or one the running agent has not
// migrated yet, holds none.
func ReadRepoConfigs(ctx context.Context, path string) ([]RepoConfig, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, fmt.Errorf("store: read repo configs: %w", err)
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("store: read repo configs: %w", err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'repo_config_seen'`).Scan(&n); err != nil {
		return nil, fmt.Errorf("store: read repo configs: %w", err)
	}
	if n == 0 {
		return nil, nil
	}
	rows, err := db.QueryContext(ctx, `SELECT repo, sha, trust, has_deployments, seen_at FROM repo_config_seen ORDER BY repo`)
	if err != nil {
		return nil, fmt.Errorf("store: read repo configs: %w", err)
	}
	defer rows.Close()
	var out []RepoConfig
	for rows.Next() {
		var c RepoConfig
		var ms int64
		if err := rows.Scan(&c.Repo, &c.SHA, &c.Trust, &c.HasDeployments, &ms); err != nil {
			return nil, fmt.Errorf("store: read repo configs: %w", err)
		}
		c.SeenAt = time.UnixMilli(ms).UTC()
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: read repo configs: %w", err)
	}
	return out, nil
}
