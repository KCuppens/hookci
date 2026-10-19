package store

import (
	"context"
	"fmt"
)

const schemaV1 = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('hwm_in', '0');
INSERT OR IGNORE INTO meta (key, value) VALUES ('hwm_out_acked', '0');

CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY,
	repo TEXT NOT NULL,
	ref TEXT NOT NULL,
	trust_domain TEXT NOT NULL,
	state TEXT NOT NULL,
	queued_at DATETIME NOT NULL,
	started_at DATETIME,
	finished_at DATETIME,
	error TEXT NOT NULL DEFAULT '',
	config_yaml TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
CREATE INDEX IF NOT EXISTS idx_runs_repo_ref ON runs(repo, ref);

CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	state TEXT NOT NULL,
	started_at DATETIME,
	finished_at DATETIME,
	exit_code INTEGER,
	error TEXT NOT NULL DEFAULT '',
	UNIQUE(run_id, name)
);

CREATE INDEX IF NOT EXISTS idx_jobs_run ON jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);

CREATE TABLE IF NOT EXISTS outbox (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	event_type TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_seq ON outbox(seq);
`

func (db *DB) migrate(ctx context.Context) error {
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS _schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("create migrations table: %w", err)
	}

	var version int
	row := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM _schema_migrations`)
	if err := row.Scan(&version); err != nil {
		return fmt.Errorf("check schema version: %w", err)
	}

	if version < 1 {
		if _, err := tx.ExecContext(ctx, schemaV1); err != nil {
			return fmt.Errorf("apply schema v1: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO _schema_migrations (version) VALUES (1)`); err != nil {
			return fmt.Errorf("record migration v1: %w", err)
		}
	}

	return tx.Commit()
}
