// Turns the recorded daily probe rows into what the /status page shows: 41 day bars per component, an
// uptime figure, the component states from the newest probe, the overall banner state and the incident
// list derived from the days with failed checks. Pure: no I/O.

import { STATUS_COMPONENTS, type StatusComponent, type StatusRow, utcDay } from "./db/status";

/** The bars per service row; the days before the first recorded check show as "No data". */
export const STATUS_WINDOW_DAYS = 41;

/** How far back the incident history reaches. */
export const INCIDENT_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** none: nothing recorded. */
export type Health = "operational" | "degraded" | "outage" | "none";

export interface DayBar {
	/** UTC day, YYYY-MM-DD. */
	day: string;
	health: Health;
	ok: number;
	total: number;
	/** Some checks failed but the day's last check passed: the service had recovered by the end of the day. */
	recovered: boolean;
}

export interface ComponentSummary {
	component: StatusComponent;
	/** STATUS_WINDOW_DAYS bars, oldest first, ending with today. */
	bars: DayBar[];
	/** Percent with two decimals, floored; null while no day in the window has a recorded check. */
	uptime: string | null;
	health: Health;
}

export interface StatusSummary {
	components: ComponentSummary[];
	overall: Health;
	/** Epoch milliseconds of the newest probe of any component; null when none ran. */
	lastCheckedAt: number | null;
	/** One entry per component and day with failed checks in the incident window, newest day first. */
	incidents: Incident[];
}

export interface Incident {
	component: StatusComponent;
	/** UTC day, YYYY-MM-DD. */
	day: string;
	failed: number;
	total: number;
}

/** A day's color: all checks passed, some failed, or more than half failed. */
function dayHealth(ok: number, total: number): Health {
	if (total === 0) return "none";
	if (ok === total) return "operational";
	return ok * 2 < total ? "outage" : "degraded";
}

/**
 * ok over total as a percent with two decimals, rounded down so a failed check never reads as 100.00.
 * Integer arithmetic only: ok * 10000 is exact and the quotient only reaches a whole number when it is one.
 */
function uptimePercent(ok: number, total: number): string {
	const hundredths = Math.floor((ok * 10000) / total);
	return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
}

/** The oldest day the page shows for now; rows before it are not needed. */
export function windowStartDay(now: number): string {
	return utcDay(now - (STATUS_WINDOW_DAYS - 1) * DAY_MS);
}

/**
 * The overall state is read from the newest probe of each component, not from the day history:
 * the API failing, or every component with data failing, is an outage; any other failure is degraded.
 * A component whose newest probe failed shows the overall state's color; a passing one is operational.
 */
export function summarize(rows: readonly StatusRow[], now: number): StatusSummary {
	const days = Array.from({ length: STATUS_WINDOW_DAYS }, (_, i) => utcDay(now - (STATUS_WINDOW_DAYS - 1 - i) * DAY_MS));
	const byKey = new Map(rows.map((r) => [`${r.component}/${r.day}`, r]));
	const newest = new Map<StatusComponent, StatusRow>();
	for (const row of rows) {
		const seen = newest.get(row.component);
		if (!seen || row.last_checked_at > seen.last_checked_at) newest.set(row.component, row);
	}
	const withData = STATUS_COMPONENTS.filter((c) => newest.has(c));
	const failing = withData.filter((c) => newest.get(c)?.last_ok === 0);
	let overall: Health = "operational";
	if (withData.length === 0) overall = "none";
	else if (failing.includes("api") || failing.length === withData.length) overall = "outage";
	else if (failing.length > 0) overall = "degraded";

	const components = STATUS_COMPONENTS.map((component): ComponentSummary => {
		const bars = days.map((day): DayBar => {
			const row = byKey.get(`${component}/${day}`);
			return {
				day,
				health: dayHealth(row?.checks_ok ?? 0, row?.checks_total ?? 0),
				ok: row?.checks_ok ?? 0,
				total: row?.checks_total ?? 0,
				recovered: row !== undefined && row.checks_ok < row.checks_total && row.last_ok === 1,
			};
		});
		const total = bars.reduce((sum, b) => sum + b.total, 0);
		const ok = bars.reduce((sum, b) => sum + b.ok, 0);
		let health: Health = "none";
		if (newest.has(component)) health = failing.includes(component) ? overall : "operational";
		return { component, bars, uptime: total > 0 ? uptimePercent(ok, total) : null, health };
	});
	const lastCheckedAt = rows.length > 0 ? Math.max(...rows.map((r) => r.last_checked_at)) : null;
	const incidents = Array.from({ length: INCIDENT_WINDOW_DAYS }, (_, i) => STATUS_WINDOW_DAYS - 1 - i).flatMap((index) =>
		components.flatMap(({ component, bars }): Incident[] => {
			const bar = bars[index];
			return bar && bar.ok < bar.total ? [{ component, day: bar.day, failed: bar.total - bar.ok, total: bar.total }] : [];
		}),
	);
	return { components, overall, lastCheckedAt, incidents };
}
