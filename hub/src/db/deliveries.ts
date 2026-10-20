// Webhook delivery and Slack event dedupe. A delivery is recorded before its
// installation is known to exist, so these helpers take the raw D1Database.

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

/** The recorded status of each of deliveryIds the hub has recorded; unknown ids are absent. */
export async function deliveryStatuses(db: D1Database, deliveryIds: readonly string[]): Promise<Map<string, DeliveryStatus>> {
	if (deliveryIds.length === 0) return new Map();
	const { results } = await db
		.prepare("SELECT delivery_id, status FROM deliveries WHERE delivery_id IN (SELECT value FROM json_each(?1))")
		.bind(JSON.stringify(deliveryIds))
		.all<{ delivery_id: string; status: DeliveryStatus }>();
	return new Map(results.map((r) => [r.delivery_id, r.status]));
}

/** Records a Slack event id until expiresAt; false when it was already recorded. */
export async function recordSlackEvent(db: D1Database, eventId: string, expiresAt: number): Promise<boolean> {
	const row = await db
		.prepare("INSERT INTO slack_events (event_id, expires_at) VALUES (?1, ?2) ON CONFLICT DO NOTHING RETURNING event_id")
		.bind(eventId, expiresAt)
		.first<{ event_id: string }>();
	return row !== null;
}
