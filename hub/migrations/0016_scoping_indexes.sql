-- deploy_renders gets the installation_id of its run, so reads and the
-- uninstall purge are scoped to the tenant. SQLite cannot add a NOT NULL
-- column without a default, so the table is rebuilt; renders whose run is
-- already gone have no tenant and are dropped.
CREATE TABLE deploy_renders_new (
	installation_id INTEGER NOT NULL,
	run_id TEXT PRIMARY KEY,
	repo TEXT NOT NULL,
	env TEXT NOT NULL,
	sha TEXT NOT NULL,
	slack_channel TEXT,
	slack_ts TEXT,
	check_run_id INTEGER,
	state TEXT NOT NULL,
	step TEXT,
	step_index INTEGER,
	steps_total INTEGER,
	started_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

INSERT INTO deploy_renders_new (installation_id, run_id, repo, env, sha, slack_channel, slack_ts, check_run_id, state, step, step_index, steps_total, started_at, updated_at)
SELECT r.installation_id, d.run_id, d.repo, d.env, d.sha, d.slack_channel, d.slack_ts, d.check_run_id, d.state, d.step, d.step_index, d.steps_total, d.started_at, d.updated_at
FROM deploy_renders d JOIN runs r ON r.run_id = d.run_id;

DROP TABLE deploy_renders;

ALTER TABLE deploy_renders_new RENAME TO deploy_renders;

CREATE INDEX deploy_renders_installation_id ON deploy_renders (installation_id);

-- Every agent event looks its run up here; the retry button looks up the
-- latest attempt by commit with repo compared NOCASE; the purge goes by age.
CREATE INDEX deploy_triggers_installation_run ON deploy_triggers (installation_id, run_id);
CREATE INDEX deploy_triggers_repo_nocase ON deploy_triggers (repo COLLATE NOCASE, sha, env, attempt);
CREATE INDEX deploy_triggers_created_at ON deploy_triggers (created_at);

-- Columns the retention purge filters on.
CREATE INDEX deliveries_received_at ON deliveries (received_at);
CREATE INDEX slack_events_expires_at ON slack_events (expires_at);
CREATE INDEX ip_rate_window_start ON ip_rate (window_start);
CREATE INDEX sink_deliveries_at ON sink_deliveries (at);

-- A re-pair stores the new credential here; it replaces credential_hash only
-- when the agent first connects with it, so the old one works until then.
ALTER TABLE agents ADD COLUMN next_credential_hash TEXT;
CREATE UNIQUE INDEX agents_next_credential_hash ON agents (next_credential_hash);
