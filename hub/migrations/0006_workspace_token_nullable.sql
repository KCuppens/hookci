-- app_uninstalled and tokens_revoked wipe the bot token, so bot_token_ct
-- becomes nullable. SQLite cannot drop a NOT NULL constraint in place, so
-- the table is rebuilt; no other table references it.
CREATE TABLE workspaces_new (
	team_id TEXT PRIMARY KEY,
	team_name TEXT NOT NULL,
	bot_user_id TEXT NOT NULL,
	bot_token_ct BLOB,
	key_version INTEGER NOT NULL,
	installed_by TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'uninstalled')),
	created_at INTEGER NOT NULL
) STRICT;

INSERT INTO workspaces_new (team_id, team_name, bot_user_id, bot_token_ct, key_version, installed_by, status, created_at)
SELECT team_id, team_name, bot_user_id, bot_token_ct, key_version, installed_by, status, created_at FROM workspaces;

DROP TABLE workspaces;

ALTER TABLE workspaces_new RENAME TO workspaces;
