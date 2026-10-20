// installations is the tenant root, keyed by the GitHub installation id, so
// these helpers take the raw D1Database.

export interface InstallationRow {
	id: number;
	account_login: string;
	account_type: "User" | "Organization";
	/** GitHub id of the account; stable across login renames. */
	account_id: number;
	/** JSON object of granted app permissions, e.g. `{"checks":"write"}`. */
	permissions: string;
	suspended_at: number | null;
	deleted_at: number | null;
	purge_after: number | null;
	created_at: number;
}

export type NewInstallation = Pick<InstallationRow, "id" | "account_login" | "account_type" | "account_id" | "created_at">;

/** Inserts or refreshes an installation; a reinstall clears deleted_at and purge_after. */
export async function upsertInstallation(db: D1Database, row: NewInstallation): Promise<void> {
	await db
		.prepare(
			`INSERT INTO installations (id, account_login, account_type, account_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
			ON CONFLICT (id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type,
				account_id = excluded.account_id, deleted_at = NULL, purge_after = NULL`,
		)
		.bind(row.id, row.account_login, row.account_type, row.account_id, row.created_at)
		.run();
}

export async function getInstallation(db: D1Database, id: number): Promise<InstallationRow | null> {
	return db.prepare("SELECT * FROM installations WHERE id = ?1").bind(id).first<InstallationRow>();
}

/** Stores the app permissions the installation currently grants. */
export async function setInstallationPermissions(db: D1Database, id: number, permissions: Record<string, string>): Promise<void> {
	await db.prepare("UPDATE installations SET permissions = ?2 WHERE id = ?1").bind(id, JSON.stringify(permissions)).run();
}

/** Sets suspended_at to at, or clears it with null (unsuspend). */
export async function markSuspended(db: D1Database, id: number, at: number | null): Promise<void> {
	await db.prepare("UPDATE installations SET suspended_at = ?2 WHERE id = ?1").bind(id, at).run();
}

export async function markDeleted(db: D1Database, id: number, at: number, purgeAfter: number): Promise<void> {
	await db.prepare("UPDATE installations SET deleted_at = ?2, purge_after = ?3 WHERE id = ?1").bind(id, at, purgeAfter).run();
}

/** Ids of up to limit installations whose purge_after has passed, oldest first. */
export async function listPurgeDue(db: D1Database, now: number, limit: number): Promise<number[]> {
	const { results } = await db
		.prepare("SELECT id FROM installations WHERE purge_after <= ?1 ORDER BY purge_after, id LIMIT ?2")
		.bind(now, limit)
		.all<{ id: number }>();
	return results.map((r) => r.id);
}

// Every table holding installation data. jobs, slack_messages and
// slack_job_replies hang off runs, so they go before it.
const PURGE_STATEMENTS = [
	"DELETE FROM jobs WHERE run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1)",
	"DELETE FROM slack_messages WHERE run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1)",
	"DELETE FROM slack_job_replies WHERE run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1)",
	"DELETE FROM runs WHERE installation_id = ?1",
	"DELETE FROM repos WHERE installation_id = ?1",
	"DELETE FROM workspace_links WHERE installation_id = ?1",
	"DELETE FROM agents WHERE installation_id = ?1",
	"DELETE FROM pair_tokens WHERE installation_id = ?1",
	"DELETE FROM repo_bindings WHERE installation_id = ?1",
	"DELETE FROM watches WHERE installation_id = ?1",
	"DELETE FROM check_runs WHERE installation_id = ?1",
	"DELETE FROM deliveries WHERE installation_id = ?1",
	"DELETE FROM author_cache WHERE installation_id = ?1",
	"DELETE FROM author_map WHERE installation_id = ?1",
	"DELETE FROM daily_counters WHERE installation_id = ?1",
	"DELETE FROM fork_approvals WHERE installation_id = ?1",
	"DELETE FROM deploy_triggers WHERE installation_id = ?1",
	"DELETE FROM installations WHERE id = ?1",
];

/** Deletes every row of the installation in every table, in one transaction. */
export async function purgeInstallation(db: D1Database, id: number): Promise<void> {
	await db.batch(PURGE_STATEMENTS.map((sql) => db.prepare(sql).bind(id)));
}
