// Fixed-window rate limits in the global ip_rate table, keyed by bucket.
// purgeExpired drops windows older than an hour.

export type RateResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Counts one hit against bucket in the window of windowMs containing now.
 * The hit that takes the count past limit and every later one in the same
 * window are refused, with the seconds left until the window ends.
 */
export async function hitIpRate(db: D1Database, bucket: string, limit: number, windowMs: number, now: number): Promise<RateResult> {
	const windowStart = now - (now % windowMs);
	const row = await db
		.prepare(
			`INSERT INTO ip_rate (bucket, count, window_start) VALUES (?1, 1, ?2)
			ON CONFLICT (bucket) DO UPDATE SET
				count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
				window_start = excluded.window_start
			RETURNING count`,
		)
		.bind(bucket, windowStart)
		.first<{ count: number }>();
	if ((row?.count ?? 1) <= limit) return { ok: true };
	return { ok: false, retryAfterSeconds: Math.ceil((windowStart + windowMs - now) / 1000) };
}
