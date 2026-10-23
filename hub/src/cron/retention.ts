// Backstop for the R2 lifecycle rule in hub/r2-lifecycle.json: deletes logs
// older than QUOTAS.retentionDays. It walks the bucket a bounded slice per
// tick and keeps its place in cron_state, so a large bucket drains over ticks.

import { getCronState, setCronState } from "../db/cron-state";
import type { Env } from "../env";
import { QUOTAS } from "../quotas";

const DAY_MS = 24 * 60 * 60 * 1000;
/** cron_state key: the R2 list cursor the last sweep stopped at; empty once a pass finished. */
const CURSOR_KEY = "logs";
const LOG_PREFIX = "logs/";
/** R2 list and delete both take at most 1000 keys. */
const R2_PAGE = 1000;

/**
 * Looks at up to batch log objects from the stored cursor and deletes those
 * uploaded before the retention cutoff. done is true when the sweep reached
 * the end of the bucket; the next call then starts over.
 */
export async function purgeExpiredLogs(env: Env, now: number, opts: { batch?: number } = {}): Promise<{ deleted: number; done: boolean }> {
	const cutoff = now - QUOTAS.retentionDays * DAY_MS;
	let remaining = opts.batch ?? 5000;
	let cursor = (await getCronState(env.DB, CURSOR_KEY)) || undefined;
	let deleted = 0;
	do {
		const page = await env.LOGS.list({ prefix: LOG_PREFIX, cursor, limit: Math.min(R2_PAGE, remaining) });
		const expired = page.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
		if (expired.length > 0) await env.LOGS.delete(expired);
		deleted += expired.length;
		remaining -= page.objects.length;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor !== undefined && remaining > 0);
	await setCronState(env.DB, CURSOR_KEY, cursor ?? "", now);
	return { deleted, done: cursor === undefined };
}
