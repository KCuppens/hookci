// Retention purge for the scheduled cron. It deletes across installations, so
// it takes the raw D1Database.

import { QUOTAS } from "../quotas";
import { ulidTimePrefix } from "../ulid";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DELIVERY_RETENTION_MS = 7 * DAY_MS;
const PAIR_TOKEN_RETENTION_MS = DAY_MS;
const UNVERIFIED_ACCOUNT_RETENTION_MS = 7 * DAY_MS;
// ip_rate rows only matter inside their rate window, the longest of which is
// 10 minutes; an hour-old window is dead.
const IP_RATE_RETENTION_MS = HOUR_MS;
/** daily_counters keeps today and the two days before it. */
const DAILY_COUNTER_DAYS = 2;

/** Rows one DELETE statement removes at most. */
const BATCH_ROWS = 500;
/**
 * Statements per table in one purge. It keeps a cron tick well inside D1's
 * per-invocation query limit; a larger backlog drains over later ticks.
 */
const MAX_BATCHES = 10;

/**
 * Deletes the rows of table whose rowids select returns, BATCH_ROWS per
 * statement; done is false when MAX_BATCHES ran out before select came up short.
 */
async function deleteBatched(db: D1Database, table: string, select: string, bind: number | string): Promise<{ deleted: number; done: boolean }> {
	const stmt = db.prepare(`DELETE FROM ${table} WHERE rowid IN (${select} LIMIT ${BATCH_ROWS})`).bind(bind);
	let deleted = 0;
	for (let i = 0; i < MAX_BATCHES; i++) {
		const { changes } = (await stmt.run()).meta;
		deleted += changes;
		if (changes < BATCH_ROWS) return { deleted, done: true };
	}
	return { deleted, done: false };
}

/**
 * A run is as old as its trigger_id, the hub ULID minted when the trigger
 * arrived; it outlives the rename of run_id to the agent's run id.
 */
async function purgeRuns(db: D1Database, cutoffPrefix: string): Promise<number> {
	const expired = "SELECT run_id FROM runs WHERE trigger_id < ?1";
	const children = [
		await deleteBatched(db, "jobs", `SELECT rowid FROM jobs WHERE run_id IN (${expired})`, cutoffPrefix),
		await deleteBatched(db, "slack_messages", `SELECT rowid FROM slack_messages WHERE run_id IN (${expired})`, cutoffPrefix),
		await deleteBatched(db, "slack_job_replies", `SELECT rowid FROM slack_job_replies WHERE run_id IN (${expired})`, cutoffPrefix),
		await deleteBatched(db, "annotations", `SELECT rowid FROM annotations WHERE run_id IN (${expired})`, cutoffPrefix),
		// check_runs are keyed by commit; a newer run of the same commit keeps them.
		await deleteBatched(
			db,
			"check_runs",
			`SELECT DISTINCT c.rowid FROM runs r
			JOIN check_runs c ON c.installation_id = r.installation_id AND c.repo_id = r.repo_id AND c.head_sha = r.sha
			WHERE r.trigger_id < ?1 AND NOT EXISTS (
				SELECT 1 FROM runs l WHERE l.installation_id = c.installation_id AND l.repo_id = c.repo_id AND l.sha = c.head_sha AND l.trigger_id >= ?1
			)`,
			cutoffPrefix,
		),
	];
	let deleted = children.reduce((n, r) => n + r.deleted, 0);
	// Runs go only once their child rows are gone, so none is left without its run.
	if (children.every((r) => r.done)) deleted += (await deleteBatched(db, "runs", "SELECT rowid FROM runs WHERE trigger_id < ?1", cutoffPrefix)).deleted;
	return deleted;
}

/** Deletes rows past their retention window from the global and run tables; returns the row count. */
export async function purgeExpired(db: D1Database, now: number): Promise<number> {
	const oldestDay = new Date(now - DAILY_COUNTER_DAYS * DAY_MS).toISOString().slice(0, 10);
	const purges: [table: string, where: string, bind: number | string][] = [
		["deliveries", "received_at < ?1", now - DELIVERY_RETENTION_MS],
		// slack_events has no received_at; expires_at is received_at plus a day.
		["slack_events", "expires_at < ?1", now],
		["oauth_states", "expires_at < ?1", now],
		["pair_tokens", "expires_at < ?1", now - PAIR_TOKEN_RETENTION_MS],
		["author_cache", "expires_at < ?1", now],
		["ip_rate", "window_start < ?1", now - IP_RATE_RETENTION_MS],
		["daily_counters", "day < ?1", oldestDay],
		["email_tokens", "expires_at < ?1", now],
		// A failure older than the lockout decay no longer counts.
		["login_attempts", "last_failure_at < ?1", now - IP_RATE_RETENTION_MS],
		// An address that never confirmed its email is dropped after a week.
		["users", "email_verified_at IS NULL AND created_at < ?1", now - UNVERIFIED_ACCOUNT_RETENTION_MS],
	];
	let deleted = 0;
	for (const [table, where, bind] of purges) {
		deleted += (await deleteBatched(db, table, `SELECT rowid FROM ${table} WHERE ${where}`, bind)).deleted;
	}
	return deleted + (await purgeRuns(db, ulidTimePrefix(now - QUOTAS.retentionDays * DAY_MS)));
}
