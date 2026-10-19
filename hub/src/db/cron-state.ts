// State the scheduled tasks carry between ticks. It is global, so these
// helpers take the raw D1Database.

export async function getCronState(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare("SELECT value FROM cron_state WHERE key = ?1").bind(key).first<{ value: string }>();
	return row?.value ?? null;
}

export async function setCronState(db: D1Database, key: string, value: string, now: number): Promise<void> {
	await db
		.prepare(
			`INSERT INTO cron_state (key, value, updated_at) VALUES (?1, ?2, ?3)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.bind(key, value, now)
		.run();
}

/** Id of the newest GitHub hook delivery a redelivery pass has looked at; null before the first pass. */
export async function getRedeliveryCursor(db: D1Database): Promise<number | null> {
	const row = await db.prepare("SELECT last_delivery_id FROM redelivery_cursor WHERE id = 1").first<{ last_delivery_id: number | null }>();
	return row?.last_delivery_id ?? null;
}

export async function setRedeliveryCursor(db: D1Database, lastDeliveryId: number, now: number): Promise<void> {
	await db
		.prepare(
			`INSERT INTO redelivery_cursor (id, last_delivery_id, updated_at) VALUES (1, ?1, ?2)
			ON CONFLICT (id) DO UPDATE SET last_delivery_id = excluded.last_delivery_id, updated_at = excluded.updated_at`,
		)
		.bind(lastDeliveryId, now)
		.run();
}
