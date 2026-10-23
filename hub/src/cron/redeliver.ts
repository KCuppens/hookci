import { getRedeliveryCursor, setRedeliveryCursor } from "../db/cron-state";
import { countRedelivery, deliveryStatuses, redeliveryAttempts } from "../db/deliveries";
import type { Env } from "../env";
import { listHookDeliveries, redeliverHook } from "../github/api";
import type { GitHubRequester } from "../github/client";
import { logEvent, reportError } from "../observability";

/** GitHub lists deliveries of the last few days; older ones are not worth sending again. */
const LOOKBACK_MS = 72 * 60 * 60 * 1000;
/** Redelivery requests per tick, so an outage's backlog cannot flood the hub at once. */
const MAX_REDELIVERIES = 50;
/** Redelivery requests per guid, so a delivery that fails every time is not sent again forever. */
const MAX_REDELIVERIES_PER_GUID = 5;

/**
 * Asks GitHub to send again the webhook deliveries the hub failed to accept
 * (app is the app requester). It pages /app/hook/deliveries newest first down
 * to the redelivery cursor or LOOKBACK_MS ago. A guid is redelivered when the
 * hub recorded it as failed (it answered 202 and then its handler threw, so
 * GitHub saw success) or as pending past PENDING_STALE_MS (its handler was cut
 * off), or when its newest attempt failed and the hub has not recorded it. A
 * guid already redelivered MAX_REDELIVERIES_PER_GUID times is given up on. The
 * cursor moves to the newest id seen, unless MAX_REDELIVERIES ran out or a
 * redelivery request failed: then it stays, and the next tick scans the same
 * range again, where the redelivered guids show as handled or count against
 * their cap.
 */
export async function redeliverFailed(env: Env, app: GitHubRequester, now: number): Promise<{ scanned: number; redelivered: number }> {
	const cursor = await getRedeliveryCursor(env.DB);
	const oldest = now - LOOKBACK_MS;
	// Guids whose newest attempt was already looked at; older attempts of them are history.
	const seen = new Set<string>();
	let newestId: number | null = null;
	let leftOver = false;
	let scanned = 0;
	let attempted = 0;
	let redelivered = 0;
	let page: string | undefined;

	scan: for (;;) {
		const { deliveries, next } = await listHookDeliveries(app, page);
		const end = deliveries.findIndex((d) => (cursor !== null && d.id <= cursor) || Date.parse(d.delivered_at) < oldest);
		const fresh = end === -1 ? deliveries : deliveries.slice(0, end);
		scanned += fresh.length;
		newestId ??= fresh[0]?.id ?? null;

		const newest = fresh.filter((d) => {
			if (seen.has(d.guid)) return false;
			seen.add(d.guid);
			return true;
		});
		const statuses = await deliveryStatuses(
			env.DB,
			newest.map((d) => d.guid),
			now,
		);
		const failed = newest.filter((d) => {
			const status = statuses.get(d.guid);
			if (status === "failed") return true;
			return status === undefined && (d.status_code >= 500 || d.status !== "OK");
		});
		const attempts = await redeliveryAttempts(
			env.DB,
			failed.map((d) => d.guid),
		);
		for (const d of failed) {
			const tries = attempts.get(d.guid) ?? 0;
			if (tries >= MAX_REDELIVERIES_PER_GUID) {
				logEvent("redelivery_abandoned", { delivery_id: d.guid, attempts: tries });
				continue;
			}
			if (attempted === MAX_REDELIVERIES) {
				leftOver = true;
				break scan;
			}
			attempted++;
			try {
				await redeliverHook(app, d.id);
				await countRedelivery(env.DB, d.guid, now);
				redelivered++;
			} catch (err) {
				leftOver = true;
				reportError(err, { task: "redeliver", hook_delivery_id: d.id, delivery_id: d.guid });
			}
		}
		if (end !== -1 || next === null) break;
		page = next;
	}

	if (!leftOver && newestId !== null && newestId !== cursor) await setRedeliveryCursor(env.DB, newestId, now);
	return { scanned, redelivered };
}
