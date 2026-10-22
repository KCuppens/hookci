// The hub's own health probes, kept per component and UTC day for the public /status
// page. The table is global (no installation owns it), so these helpers take the raw D1Database.

export const STATUS_COMPONENTS = ["api", "agents", "logs"] as const;
export type StatusComponent = (typeof STATUS_COMPONENTS)[number];

/** Daily rows older than this many days are dropped on every write. */
export const STATUS_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StatusCheck {
	component: StatusComponent;
	ok: boolean;
	latencyMs: number;
}

export interface StatusRow {
	component: StatusComponent;
	/** UTC day, YYYY-MM-DD. */
	day: string;
	checks_ok: number;
	checks_total: number;
	last_checked_at: number;
	/** 1 when the newest probe of the day passed, else 0. */
	last_ok: number;
	last_latency_ms: number;
}

/** The UTC day, YYYY-MM-DD, that the epoch-millisecond time falls on. */
export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** The cheapest round trip to D1; throws when the database does not answer. */
export async function pingD1(db: D1Database): Promise<void> {
	await db.prepare("SELECT 1").first();
}

/** Adds each probe to its component's row for the day of now and drops rows past the retention. */
export async function recordStatusChecks(db: D1Database, checks: readonly StatusCheck[], now: number): Promise<void> {
	const day = utcDay(now);
	const upsert = db.prepare(
		`INSERT INTO status_checks (component, day, checks_ok, checks_total, last_checked_at, last_ok, last_latency_ms)
		VALUES (?1, ?2, ?3, 1, ?4, ?3, ?5)
		ON CONFLICT (component, day) DO UPDATE SET
			checks_ok = checks_ok + excluded.checks_ok,
			checks_total = checks_total + 1,
			last_checked_at = excluded.last_checked_at,
			last_ok = excluded.last_ok,
			last_latency_ms = excluded.last_latency_ms`,
	);
	const prune = db.prepare("DELETE FROM status_checks WHERE day < ?1").bind(utcDay(now - STATUS_RETENTION_DAYS * DAY_MS));
	await db.batch([...checks.map((c) => upsert.bind(c.component, day, c.ok ? 1 : 0, now, Math.max(0, Math.round(c.latencyMs)))), prune]);
}

/** Every daily row from sinceDay (inclusive, YYYY-MM-DD) on, oldest first. */
export async function loadStatusRows(db: D1Database, sinceDay: string): Promise<StatusRow[]> {
	const { results } = await db
		.prepare(
			`SELECT component, day, checks_ok, checks_total, last_checked_at, last_ok, last_latency_ms
			FROM status_checks WHERE day >= ?1 ORDER BY day, component`,
		)
		.bind(sinceDay)
		.all<StatusRow>();
	return results;
}
