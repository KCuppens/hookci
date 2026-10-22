import type { TenantDb } from "./tenant";

export interface WatchRow {
	installation_id: number;
	repo_id: number;
	team_id: string;
	channel_id: string;
	notify: "normal" | "quiet";
	alert: "channel" | "dm";
	status: "active" | "broken";
	broken_reason: string | null;
	created_by: string;
	/** The channel's name when it was watched; null before it was recorded and for a direct message. */
	channel_name: string | null;
}

export type NewWatch = Pick<WatchRow, "repo_id" | "team_id" | "channel_id" | "notify" | "alert" | "created_by"> & { channel_name?: string | null };

/** Watches a repo from a channel; watching again updates the modes and reactivates a broken watch. */
export async function addWatch(t: TenantDb, row: NewWatch): Promise<void> {
	await t.run(
		`INSERT INTO watches (installation_id, repo_id, team_id, channel_id, notify, alert, created_by, channel_name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
		ON CONFLICT (installation_id, repo_id, team_id, channel_id) DO UPDATE SET notify = excluded.notify, alert = excluded.alert,
			status = 'active', broken_reason = NULL, channel_name = COALESCE(excluded.channel_name, channel_name)`,
		row.repo_id,
		row.team_id,
		row.channel_id,
		row.notify,
		row.alert,
		row.created_by,
		row.channel_name ?? null,
	);
}

/** Stops a watch; false when there was none. */
export async function removeWatch(t: TenantDb, repoId: number, teamId: string, channelId: string): Promise<boolean> {
	const res = await t.run(
		"DELETE FROM watches WHERE installation_id = ?1 AND repo_id = ?2 AND team_id = ?3 AND channel_id = ?4",
		repoId,
		teamId,
		channelId,
	);
	return res.meta.changes > 0;
}

export async function listWatchesForRepo(t: TenantDb, repoId: number): Promise<WatchRow[]> {
	return t.all<WatchRow>(
		"SELECT * FROM watches WHERE installation_id = ?1 AND repo_id = ?2 ORDER BY team_id, channel_id",
		repoId,
	);
}

export async function listWatchesForRepos(t: TenantDb, repoIds: readonly number[]): Promise<WatchRow[]> {
	if (repoIds.length === 0) return [];
	return t.all<WatchRow>(
		"SELECT * FROM watches WHERE installation_id = ?1 AND repo_id IN (SELECT value FROM json_each(?2)) ORDER BY team_id, channel_id, repo_id",
		JSON.stringify(repoIds),
	);
}

/**
 * Marks every active watch of a channel broken, across installations, when
 * Slack reports the channel unusable; returns the Slack users who created the
 * watches it broke, each once, so they hear about it once.
 */
export async function markWatchBroken(db: D1Database, teamId: string, channelId: string, reason: string): Promise<string[]> {
	const { results } = await db
		.prepare(
			"UPDATE watches SET status = 'broken', broken_reason = ?3 WHERE team_id = ?1 AND channel_id = ?2 AND status = 'active' RETURNING created_by",
		)
		.bind(teamId, channelId, reason)
		.all<{ created_by: string }>();
	return [...new Set(results.map((row) => row.created_by))];
}
