-- zeroci hub D1 schema. Every timestamp is INTEGER unix milliseconds.
-- Tenant data carries installation_id, or (jobs, slack_messages) is reachable
-- only through runs.run_id; hub/src/db/installations.ts purgeInstallation
-- deletes all of it.

CREATE TABLE installations (
	id INTEGER PRIMARY KEY,
	account_login TEXT NOT NULL,
	account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
	suspended_at INTEGER,
	deleted_at INTEGER,
	purge_after INTEGER,
	created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE repos (
	installation_id INTEGER NOT NULL,
	repo_id INTEGER NOT NULL,
	full_name TEXT NOT NULL,
	default_branch TEXT NOT NULL,
	PRIMARY KEY (installation_id, repo_id)
) STRICT;

CREATE TABLE workspaces (
	team_id TEXT PRIMARY KEY,
	team_name TEXT NOT NULL,
	bot_user_id TEXT NOT NULL,
	bot_token_ct BLOB NOT NULL,
	key_version INTEGER NOT NULL,
	installed_by TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'uninstalled')),
	created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE workspace_links (
	team_id TEXT NOT NULL,
	installation_id INTEGER NOT NULL,
	linked_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (team_id, installation_id)
) STRICT;

CREATE TABLE user_links (
	team_id TEXT NOT NULL,
	slack_user_id TEXT NOT NULL,
	github_user_id INTEGER NOT NULL,
	github_login TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (team_id, slack_user_id)
) STRICT;

CREATE INDEX user_links_github_user_id ON user_links (github_user_id);

CREATE TABLE agents (
	agent_id TEXT PRIMARY KEY,
	installation_id INTEGER NOT NULL,
	name TEXT NOT NULL,
	hostname TEXT,
	os TEXT,
	arch TEXT,
	credential_hash TEXT NOT NULL UNIQUE,
	protocol_version INTEGER,
	agent_version TEXT,
	last_seen_at INTEGER,
	revoked_at INTEGER,
	paired_by_github_id INTEGER NOT NULL,
	paired_at INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'revoked'))
) STRICT;

CREATE INDEX agents_installation_id ON agents (installation_id);

CREATE TABLE pair_tokens (
	token_hash TEXT PRIMARY KEY,
	installation_id INTEGER NOT NULL,
	created_by_github_id INTEGER NOT NULL,
	replaces_agent_id TEXT,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
) STRICT;

-- target is 'checks' or 'deploy:<env>'.
CREATE TABLE repo_bindings (
	installation_id INTEGER NOT NULL,
	repo_id INTEGER NOT NULL,
	target TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	PRIMARY KEY (installation_id, repo_id, target)
) STRICT;

CREATE TABLE watches (
	installation_id INTEGER NOT NULL,
	repo_id INTEGER NOT NULL,
	team_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	notify TEXT NOT NULL DEFAULT 'normal' CHECK (notify IN ('normal', 'quiet')),
	alert TEXT NOT NULL DEFAULT 'channel' CHECK (alert IN ('channel', 'dm')),
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'broken')),
	broken_reason TEXT,
	created_by TEXT NOT NULL,
	PRIMARY KEY (installation_id, repo_id, team_id, channel_id)
) STRICT;

CREATE TABLE runs (
	run_id TEXT PRIMARY KEY,
	installation_id INTEGER NOT NULL,
	repo_id INTEGER NOT NULL,
	sha TEXT NOT NULL,
	ref TEXT NOT NULL,
	event TEXT NOT NULL,
	pr_number INTEGER,
	env TEXT,
	attempt INTEGER NOT NULL,
	trigger_id TEXT NOT NULL,
	agent_id TEXT,
	state TEXT NOT NULL,
	reason TEXT,
	author_login TEXT,
	commit_title TEXT,
	started_at INTEGER,
	finished_at INTEGER,
	duration_ms INTEGER,
	log_key TEXT
) STRICT;

CREATE INDEX runs_installation_repo_started ON runs (installation_id, repo_id, started_at DESC);
CREATE INDEX runs_trigger_id ON runs (trigger_id);

CREATE TABLE jobs (
	run_id TEXT NOT NULL,
	name TEXT NOT NULL,
	state TEXT NOT NULL,
	step TEXT,
	step_index INTEGER,
	steps_total INTEGER,
	duration_ms INTEGER,
	PRIMARY KEY (run_id, name)
) STRICT;

CREATE TABLE slack_messages (
	run_id TEXT NOT NULL,
	team_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	ts TEXT NOT NULL,
	alert_ts TEXT,
	PRIMARY KEY (run_id, team_id, channel_id)
) STRICT;

CREATE TABLE check_runs (
	installation_id INTEGER NOT NULL,
	repo_id INTEGER NOT NULL,
	head_sha TEXT NOT NULL,
	name TEXT NOT NULL,
	check_run_id INTEGER NOT NULL,
	PRIMARY KEY (installation_id, repo_id, head_sha, name)
) STRICT;

CREATE TABLE deliveries (
	delivery_id TEXT PRIMARY KEY,
	received_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	event TEXT NOT NULL,
	installation_id INTEGER,
	status TEXT NOT NULL CHECK (status IN ('processed', 'dropped', 'failed')),
	note TEXT
) STRICT;

CREATE TABLE slack_events (
	event_id TEXT PRIMARY KEY,
	expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE author_cache (
	installation_id INTEGER NOT NULL,
	team_id TEXT NOT NULL,
	key TEXT NOT NULL,
	slack_user_id TEXT,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (installation_id, team_id, key)
) STRICT;

CREATE TABLE author_map (
	installation_id INTEGER NOT NULL,
	team_id TEXT NOT NULL,
	github_login TEXT NOT NULL,
	slack_user_id TEXT NOT NULL,
	PRIMARY KEY (installation_id, team_id, github_login)
) STRICT;

CREATE TABLE ip_rate (
	bucket TEXT PRIMARY KEY,
	count INTEGER NOT NULL,
	window_start INTEGER NOT NULL
) STRICT;

CREATE TABLE redelivery_cursor (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	last_delivery_id INTEGER,
	updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE daily_counters (
	installation_id INTEGER NOT NULL,
	day TEXT NOT NULL,
	runs INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (installation_id, day)
) STRICT;

CREATE TABLE oauth_states (
	nonce_hash TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('github_install', 'github_link', 'slack_install')),
	payload TEXT,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
) STRICT;

CREATE TABLE fork_approvals (
	installation_id INTEGER NOT NULL,
	repo_id INTEGER NOT NULL,
	pr_number INTEGER NOT NULL,
	head_sha TEXT NOT NULL,
	approved_by_github_id INTEGER NOT NULL,
	approved_at INTEGER NOT NULL,
	PRIMARY KEY (installation_id, repo_id, pr_number, head_sha)
) STRICT;
