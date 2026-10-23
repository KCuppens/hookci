-- Optional email and password accounts (ACCOUNTS_ENABLED), and Google sign-in.
-- All four tables are global: none belongs to an installation. What an account
-- may see is decided per session from what GitHub says its linked GitHub user
-- can access, never from these rows.

CREATE TABLE users (
	id TEXT PRIMARY KEY CHECK (length(id) = 26),
	email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
	-- Lowercased email; the one identity key. UNIQUE so two accounts never share an address.
	email_norm TEXT NOT NULL UNIQUE CHECK (length(email_norm) BETWEEN 3 AND 254 AND email_norm = lower(email_norm)),
	-- Versioned PBKDF2 string, see src/accounts/password.ts. NULL for an account that only signs in with Google.
	password_hash TEXT CHECK (password_hash IS NULL OR length(password_hash) BETWEEN 20 AND 400),
	-- Password sign-in needs this; set by following the emailed link, a reset, or by Google confirming the address.
	email_verified_at INTEGER CHECK (email_verified_at IS NULL OR email_verified_at > 0),
	google_sub TEXT CHECK (google_sub IS NULL OR length(google_sub) BETWEEN 1 AND 255),
	github_user_id INTEGER CHECK (github_user_id IS NULL OR github_user_id > 0),
	github_login TEXT CHECK (github_login IS NULL OR length(github_login) BETWEEN 1 AND 39),
	created_at INTEGER NOT NULL CHECK (created_at > 0),
	CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL),
	CHECK ((github_user_id IS NULL) = (github_login IS NULL)),
	CHECK (google_sub IS NULL OR email_verified_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX users_github_user_id ON users (github_user_id) WHERE github_user_id IS NOT NULL;
CREATE INDEX users_unverified ON users (created_at) WHERE email_verified_at IS NULL;

-- Emailed single-use links. Only the SHA-256 of the 32 random bytes is stored.
CREATE TABLE email_tokens (
	token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
	user_id TEXT NOT NULL CHECK (length(user_id) = 26),
	kind TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
	created_at INTEGER NOT NULL CHECK (created_at > 0),
	expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
	used_at INTEGER CHECK (used_at IS NULL OR used_at > 0)
) STRICT;

CREATE INDEX email_tokens_user ON email_tokens (user_id, kind);
CREATE INDEX email_tokens_expires ON email_tokens (expires_at);

-- Failed password sign-ins per email, keyed by an HMAC of the address so the
-- table holds no email. It counts unknown addresses the same as known ones.
CREATE TABLE login_attempts (
	email_hash TEXT PRIMARY KEY CHECK (length(email_hash) = 64),
	failures INTEGER NOT NULL CHECK (failures >= 0),
	last_failure_at INTEGER NOT NULL CHECK (last_failure_at > 0),
	locked_until INTEGER NOT NULL DEFAULT 0 CHECK (locked_until >= 0)
) STRICT;

CREATE INDEX login_attempts_last ON login_attempts (last_failure_at);

-- Google sign-in is a sixth kind of OAuth state. SQLite cannot change a CHECK
-- constraint in place, so the table is rebuilt as in 0020; no other table
-- references it. Pending states carry over.
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
