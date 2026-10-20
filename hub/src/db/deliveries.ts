// Webhook delivery and Slack event dedupe. A delivery is recorded before its
// installation is known to exist, so these helpers take the raw D1Database.

/** pending: accepted and its handler not yet finished; the others are final. */
export type DeliveryStatus = "pending" | "processed" | "dropped" | "failed";

/**
 * A handler runs in waitUntil, which the runtime cuts off 30 s after the
 * response; a delivery still pending this long after its receipt lost its
 * handler and may be claimed again.
 */
export const PENDING_STALE_MS = 5 * 60 * 1000;

export interface DeliveryRow {
	delivery_id: string;
	received_at: number;
	expires_at: number;
	event: string;
	installation_id: number | null;
	status: DeliveryStatus;
	note: string | null;
}

/** Records a delivery; false when the delivery id was already recorded. */
export async function recordDelivery(db: D1Database, row: DeliveryRow): Promise<boolean> {
	const res = await db
		.prepare(
			`INSERT INTO deliveries (delivery_id, received_at, expires_at, event, installation_id, status, note)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (delivery_id) DO NOTHING`,
		)
		.bind(row.delivery_id, row.received_at, row.expires_at, row.event, row.installation_id, row.status, row.note)
		.run();
	return res.meta.changes === 1;
}

export async function markDelivery(db: D1Database, deliveryId: string, status: DeliveryStatus, note: string | null): Promise<void> {
	await db.prepare("UPDATE deliveries SET status = ?2, note = ?3 WHERE delivery_id = ?1").bind(deliveryId, status, note).run();
}

/**
 * Records row over the delivery already recorded under its id when that one
 * may be tried again, as when GitHub redelivers it: its handler failed, or it
 * is still pending PENDING_STALE_MS after its receipt. False otherwise.
 */
export async function reclaimDelivery(db: D1Database, row: DeliveryRow): Promise<boolean> {
	const res = await db
		.prepare(
			`UPDATE deliveries SET received_at = ?2, expires_at = ?3, status = ?4, note = ?5
			WHERE delivery_id = ?1 AND (status = 'failed' OR (status = 'pending' AND received_at < ?6))`,
		)
		.bind(row.delivery_id, row.received_at, row.expires_at, row.status, row.note, row.received_at - PENDING_STALE_MS)
		.run();
	return res.meta.changes === 1;
}

/**
 * The status of each of deliveryIds the hub has recorded, as of now; unknown
 * ids are absent. A delivery pending PENDING_STALE_MS past its receipt reads
 * as failed, since its handler was cut off.
 */
export async function deliveryStatuses(db: D1Database, deliveryIds: readonly string[], now: number): Promise<Map<string, DeliveryStatus>> {
	if (deliveryIds.length === 0) return new Map();
	const { results } = await db
		.prepare(
			`SELECT delivery_id, CASE WHEN status = 'pending' AND received_at < ?2 THEN 'failed' ELSE status END AS status
			FROM deliveries WHERE delivery_id IN (SELECT value FROM json_each(?1))`,
		)
		.bind(JSON.stringify(deliveryIds), now - PENDING_STALE_MS)
		.all<{ delivery_id: string; status: DeliveryStatus }>();
	return new Map(results.map((r) => [r.delivery_id, r.status]));
}

/** How many redeliveries the hub asked GitHub for, per guid of guids; guids never redelivered are absent. */
export async function redeliveryAttempts(db: D1Database, guids: readonly string[]): Promise<Map<string, number>> {
	if (guids.length === 0) return new Map();
	const { results } = await db
		.prepare("SELECT guid, attempts FROM hook_redeliveries WHERE guid IN (SELECT value FROM json_each(?1))")
		.bind(JSON.stringify(guids))
		.all<{ guid: string; attempts: number }>();
	return new Map(results.map((r) => [r.guid, r.attempts]));
}

/** Counts one redelivery the hub asked GitHub for of guid, at now. */
export async function countRedelivery(db: D1Database, guid: string, now: number): Promise<void> {
	await db
		.prepare(
			`INSERT INTO hook_redeliveries (guid, attempts, last_at) VALUES (?1, 1, ?2)
			ON CONFLICT (guid) DO UPDATE SET attempts = attempts + 1, last_at = ?2`,
		)
		.bind(guid, now)
		.run();
}

/** Records a Slack event id until expiresAt; false when it was already recorded. */
export async function recordSlackEvent(db: D1Database, eventId: string, expiresAt: number): Promise<boolean> {
	const row = await db
		.prepare("INSERT INTO slack_events (event_id, expires_at) VALUES (?1, ?2) ON CONFLICT DO NOTHING RETURNING event_id")
		.bind(eventId, expiresAt)
		.first<{ event_id: string }>();
	return row !== null;
}
