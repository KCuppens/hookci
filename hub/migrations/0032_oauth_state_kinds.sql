-- 0020 and 0021 first shipped with kind lists that left out 0014's log
-- sign-in kind 'github_logs'. A database that applied those versions refuses
-- log sign-in states, so the table is rebuilt once more with all six kinds.
-- SQLite cannot change a CHECK constraint in place; no other table references
-- this one. Pending states carry over.
CREATE TABLE oauth_states_new (
	nonce_hash TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('github_install', 'github_link', 'slack_install', 'github_logs', 'dashboard_login', 'google_login')),
	payload TEXT,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
) STRICT;

INSERT INTO oauth_states_new (nonce_hash, kind, payload, expires_at, used_at)
SELECT nonce_hash, kind, payload, expires_at, used_at FROM oauth_states;

DROP TABLE oauth_states;

ALTER TABLE oauth_states_new RENAME TO oauth_states;
