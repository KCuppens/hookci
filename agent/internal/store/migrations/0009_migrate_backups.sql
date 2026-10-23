CREATE TABLE migrate_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL, env TEXT NOT NULL,
  run_id TEXT NOT NULL, sha TEXT NOT NULL,
  path TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX migrate_backups_repo_env ON migrate_backups(repo, env, created_at);
