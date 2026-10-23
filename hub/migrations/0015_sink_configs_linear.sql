-- Adds 'linear' to the sink kinds. SQLite cannot alter a CHECK, so the table
-- is rebuilt with the same columns and index; no table references it.
CREATE TABLE sink_configs_new (
	installation_id INTEGER NOT NULL,
	id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('telegram', 'webhook', 'linear')),
	repo TEXT NOT NULL,
	target TEXT NOT NULL,
	secret_enc BLOB,
	key_version INTEGER,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	disabled_at INTEGER,
	disabled_reason TEXT,
	label TEXT,
	PRIMARY KEY (installation_id, id)
) STRICT;

INSERT INTO sink_configs_new (installation_id, id, kind, repo, target, secret_enc, key_version, created_by, created_at, disabled_at, disabled_reason, label)
	SELECT installation_id, id, kind, repo, target, secret_enc, key_version, created_by, created_at, disabled_at, disabled_reason, label FROM sink_configs;

DROP TABLE sink_configs;

ALTER TABLE sink_configs_new RENAME TO sink_configs;

CREATE INDEX sink_configs_repo ON sink_configs (installation_id, repo);
