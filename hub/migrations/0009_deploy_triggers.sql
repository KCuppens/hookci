-- Deploy triggers the push-to-deploy chain sent to agents, one per
-- (repo, sha, env, attempt), with the agent's reply. repo is owner/name;
-- installation_id scopes the row to its tenant for tenantDb and purges.
CREATE TABLE deploy_triggers (
	installation_id INTEGER NOT NULL,
	repo TEXT NOT NULL,
	sha TEXT NOT NULL,
	env TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	event TEXT NOT NULL CHECK (event IN ('push', 'retry')),
	ref TEXT NOT NULL,
	trigger_id TEXT NOT NULL UNIQUE,
	agent_id TEXT NOT NULL,
	run_id TEXT,
	status TEXT NOT NULL CHECK (status IN ('sent', 'accepted', 'rejected')),
	reason TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (repo, sha, env, attempt)
) STRICT;
