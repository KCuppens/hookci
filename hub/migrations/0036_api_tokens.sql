-- Installation-scoped API tokens, for the MCP server and any future
-- programmatic HTTP clients. A token grants the same access the dashboard's
-- Retry/Cancel buttons do: no GitHub user identity is attached to it, so it
-- is not run through requirePermission's GitHub-role check.
CREATE TABLE api_tokens (
	installation_id INTEGER NOT NULL REFERENCES installations (id),
	token_id TEXT NOT NULL,
	token_hash TEXT NOT NULL,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	created_by_github_id INTEGER NOT NULL,
	last_used_at INTEGER,
	revoked_at INTEGER,
	PRIMARY KEY (installation_id, token_id)
);

CREATE UNIQUE INDEX api_tokens_hash ON api_tokens (token_hash);
