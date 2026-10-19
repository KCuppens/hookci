// Webhook delivery dedupe and expiry of the short-lived global tables. A
// delivery is recorded before its installation is known to exist, so these
// helpers take the raw D1Database.

export type DeliveryStatus = "processed" | "dropped" | "failed";

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
 * Claims a delivery recorded as failed for another attempt, as when GitHub
 * redelivers it under the same delivery id; false unless it had failed.
 */
export async function reclaimFailedDelivery(db: D1Database, deliveryId: string): Promise<boolean> {
	const res = await db
		.prepare("UPDATE deliveries SET status = 'processed', note = NULL WHERE delivery_id = ?1 AND status = 'failed'")
		.bind(deliveryId)
		.run();
	return res.meta.changes === 1;
}

// ip_rate rows only matter inside their rate window, the longest of which is
// 10 minutes; an hour-old window is dead.
const IP_RATE_TTL_MS = 60 * 60 * 1000;

/** Deletes expired deliveries, Slack event ids, OAuth states, author cache entries and rate windows; returns the row count. */
export async function purgeExpired(db: D1Database, now: number): Promise<number> {
	const results = await db.batch([
		db.prepare("DELETE FROM deliveries WHERE expires_at < ?1").bind(now),
		db.prepare("DELETE FROM slack_events WHERE expires_at < ?1").bind(now),
		db.prepare("DELETE FROM oauth_states WHERE expires_at < ?1").bind(now),
		db.prepare("DELETE FROM author_cache WHERE expires_at < ?1").bind(now),
		db.prepare("DELETE FROM ip_rate WHERE window_start < ?1").bind(now - IP_RATE_TTL_MS),
	]);
	return results.reduce((n, r) => n + r.meta.changes, 0);
}
