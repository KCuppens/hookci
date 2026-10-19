// What ZeroCI stores about one Slack user, for /zeroci delete-my-data and
// /zeroci export. user_links, author_map and author_cache rows are keyed by
// Slack team and user across installations, so these helpers take the raw
// D1Database; runs go through TenantDb per installation.

import type { RunRow } from "./runs";
import { tenantDb } from "./tenant";

export interface DeletedUserData {
	links: number;
	authorMappings: number;
	authorCache: number;
}

export interface AuthorMappingRow {
	installation_id: number;
	github_login: string;
}

export type AuthoredRun = RunRow & { full_name: string | null };

/** Deletes the Slack user's GitHub link, author mappings and cached author lookups in the team; returns how many rows each lost. */
export async function deleteSlackUserData(db: D1Database, teamId: string, slackUserId: string): Promise<DeletedUserData> {
	const [links, mappings, cache] = await db.batch([
		db.prepare("DELETE FROM user_links WHERE team_id = ?1 AND slack_user_id = ?2").bind(teamId, slackUserId),
		db.prepare("DELETE FROM author_map WHERE team_id = ?1 AND slack_user_id = ?2").bind(teamId, slackUserId),
		db.prepare("DELETE FROM author_cache WHERE team_id = ?1 AND slack_user_id = ?2").bind(teamId, slackUserId),
	]);
	return { links: links?.meta.changes ?? 0, authorMappings: mappings?.meta.changes ?? 0, authorCache: cache?.meta.changes ?? 0 };
}

/** The GitHub logins mapped to the Slack user in the team, per installation. */
export async function listAuthorMappings(db: D1Database, teamId: string, slackUserId: string): Promise<AuthorMappingRow[]> {
	const { results } = await db
		.prepare(
			"SELECT installation_id, github_login FROM author_map WHERE team_id = ?1 AND slack_user_id = ?2 ORDER BY installation_id, github_login",
		)
		.bind(teamId, slackUserId)
		.all<AuthorMappingRow>();
	return results;
}

/**
 * Runs of the installation authored by githubLogin (ignoring case) whose
 * trigger id is at least minTriggerId; trigger ids are ULIDs, so this keeps
 * the runs triggered since the time minTriggerId encodes. Newest first.
 */
export async function listAuthoredRuns(
	db: D1Database,
	installationId: number,
	githubLogin: string,
	minTriggerId: string,
): Promise<AuthoredRun[]> {
	return tenantDb(db, installationId).all<AuthoredRun>(
		`SELECT r.*, p.full_name FROM runs r
		LEFT JOIN repos p ON p.installation_id = r.installation_id AND p.repo_id = r.repo_id
		WHERE r.installation_id = ?1 AND r.author_login = ?2 COLLATE NOCASE AND r.trigger_id >= ?3
		ORDER BY r.rowid DESC`,
		githubLogin,
		minTriggerId,
	);
}
