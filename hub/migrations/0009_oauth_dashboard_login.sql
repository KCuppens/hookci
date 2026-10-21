-- The dashboard sign-in is a fourth kind of OAuth state. SQLite cannot change a
-- CHECK constraint in place, so the table is rebuilt; no other table
-- references it. Pending states carry over.
CREATE TABLE oauth_states_new (
	nonce_hash TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('github_install', 'github_link', 'slack_install', 'dashboard_login')),
	payload TEXT,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
) STRICT;

INSERT INTO oauth_states_new (nonce_hash, kind, payload, expires_at, used_at)
SELECT nonce_hash, kind, payload, expires_at, used_at FROM oauth_states;

DROP TABLE oauth_states;

ALTER TABLE oauth_states_new RENAME TO oauth_states;
