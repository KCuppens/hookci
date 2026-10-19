// Slack workspaces and user links are keyed by Slack team, not by
// installation, so their helpers take the raw D1Database. workspace_links
// rows belong to an installation and go through TenantDb.

import type { TenantDb } from "./tenant";

export type WorkspaceStatus = "active" | "revoked" | "uninstalled";

export interface WorkspaceRow {
	team_id: string;
	team_name: string;
	bot_user_id: string;
	/** IV || AES-GCM ciphertext of the bot token under key_version. */
	bot_token_ct: Uint8Array;
	key_version: number;
	installed_by: string;
	status: WorkspaceStatus;
	created_at: number;
}

export interface WorkspaceLinkRow {
	team_id: string;
	installation_id: number;
	linked_by: string;
	created_at: number;
}

export interface UserLinkRow {
	team_id: string;
	slack_user_id: string;
	github_user_id: number;
	github_login: string;
	created_at: number;
}

// D1 returns BLOB columns as arrays of byte values.
type StoredWorkspace = Omit<WorkspaceRow, "bot_token_ct"> & { bot_token_ct: number[] };

/** Inserts a workspace or, on reinstall, replaces everything but created_at. */
export async function upsertWorkspace(db: D1Database, row: WorkspaceRow): Promise<void> {
	await db
		.prepare(
			`INSERT INTO workspaces (team_id, team_name, bot_user_id, bot_token_ct, key_version, installed_by, status, created_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
			ON CONFLICT (team_id) DO UPDATE SET team_name = excluded.team_name, bot_user_id = excluded.bot_user_id,
				bot_token_ct = excluded.bot_token_ct, key_version = excluded.key_version, installed_by = excluded.installed_by,
				status = excluded.status`,
		)
		.bind(row.team_id, row.team_name, row.bot_user_id, row.bot_token_ct, row.key_version, row.installed_by, row.status, row.created_at)
		.run();
}

export async function getWorkspace(db: D1Database, teamId: string): Promise<WorkspaceRow | null> {
	const row = await db.prepare("SELECT * FROM workspaces WHERE team_id = ?1").bind(teamId).first<StoredWorkspace>();
	return row && { ...row, bot_token_ct: new Uint8Array(row.bot_token_ct) };
}

export async function setWorkspaceStatus(db: D1Database, teamId: string, status: WorkspaceStatus): Promise<void> {
	await db.prepare("UPDATE workspaces SET status = ?2 WHERE team_id = ?1").bind(teamId, status).run();
}

/** Links a workspace to the installation; linking twice keeps the first link. */
export async function linkWorkspace(t: TenantDb, teamId: string, linkedBy: string, at: number): Promise<void> {
	await t.run(
		"INSERT INTO workspace_links (installation_id, team_id, linked_by, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING",
		teamId,
		linkedBy,
		at,
	);
}

export async function unlinkWorkspace(t: TenantDb, teamId: string): Promise<void> {
	await t.run("DELETE FROM workspace_links WHERE installation_id = ?1 AND team_id = ?2", teamId);
}

/** Workspaces linked to the installation, whatever their status. */
export async function listWorkspacesForInstallation(t: TenantDb): Promise<WorkspaceRow[]> {
	const rows = await t.all<StoredWorkspace>(
		`SELECT w.* FROM workspaces w JOIN workspace_links l ON l.team_id = w.team_id
		WHERE l.installation_id = ?1 ORDER BY w.team_name, w.team_id`,
	);
	return rows.map((row) => ({ ...row, bot_token_ct: new Uint8Array(row.bot_token_ct) }));
}

/** Links a Slack user to a GitHub identity; relinking replaces the old identity. */
export async function upsertUserLink(db: D1Database, row: UserLinkRow): Promise<void> {
	await db
		.prepare(
			`INSERT INTO user_links (team_id, slack_user_id, github_user_id, github_login, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
			ON CONFLICT (team_id, slack_user_id) DO UPDATE SET github_user_id = excluded.github_user_id,
				github_login = excluded.github_login, created_at = excluded.created_at`,
		)
		.bind(row.team_id, row.slack_user_id, row.github_user_id, row.github_login, row.created_at)
		.run();
}

export async function getUserLink(db: D1Database, teamId: string, slackUserId: string): Promise<UserLinkRow | null> {
	return db
		.prepare("SELECT * FROM user_links WHERE team_id = ?1 AND slack_user_id = ?2")
		.bind(teamId, slackUserId)
		.first<UserLinkRow>();
}

export async function deleteUserLink(db: D1Database, teamId: string, slackUserId: string): Promise<boolean> {
	const res = await db.prepare("DELETE FROM user_links WHERE team_id = ?1 AND slack_user_id = ?2").bind(teamId, slackUserId).run();
	return res.meta.changes > 0;
}

/** Deletes every Slack link of a GitHub user in every team; returns how many. */
export async function deleteUserLinksByGithubId(db: D1Database, githubUserId: number): Promise<number> {
	const res = await db.prepare("DELETE FROM user_links WHERE github_user_id = ?1").bind(githubUserId).run();
	return res.meta.changes;
}
