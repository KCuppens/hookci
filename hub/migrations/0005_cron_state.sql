-- Small key-value state the scheduled tasks carry between ticks, such as the
-- reconcile cursor.
CREATE TABLE cron_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;

-- Reconcile asks whether a commit already has a run, and the retention purge
-- matches check_runs to runs, both by (installation_id, repo_id, sha).
CREATE INDEX runs_installation_repo_sha ON runs (installation_id, repo_id, sha);
