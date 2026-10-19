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
}

export type NewWatch = Pick<WatchRow, "repo_id" | "team_id" | "channel_id" | "notify" | "alert" | "created_by">;

/** Watches a repo from a channel; watching again updates the modes and reactivates a broken watch. */
export async function addWatch(t: TenantDb, row: NewWatch): Promise<void> {
	await t.run(
		`INSERT INTO watches (installation_id, repo_id, team_id, channel_id, notify, alert, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
		ON CONFLICT (installation_id, repo_id, team_id, channel_id) DO UPDATE SET notify = excluded.notify, alert = excluded.alert,
			status = 'active', broken_reason = NULL`,
		row.repo_id,
		row.team_id,
		row.channel_id,
		row.notify,
		row.alert,
		row.created_by,
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

/**
 * Marks every watch of a channel broken, across installations, when Slack
 * reports the channel unusable; returns how many watches changed.
 */
export async function markWatchBroken(db: D1Database, teamId: string, channelId: string, reason: string): Promise<number> {
	const res = await db
		.prepare("UPDATE watches SET status = 'broken', broken_reason = ?3 WHERE team_id = ?1 AND channel_id = ?2")
		.bind(teamId, channelId, reason)
		.run();
	return res.meta.changes;
}
