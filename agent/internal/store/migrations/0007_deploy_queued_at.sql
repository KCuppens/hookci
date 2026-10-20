ALTER TABLE deploy_runs ADD COLUMN queued_at INTEGER NOT NULL DEFAULT 0;
UPDATE deploy_runs SET queued_at = created_at;
