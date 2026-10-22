// File annotations the agent parsed from a job's output, stored for the run page. The GitHub check
// run gets them too (sinks/checks.ts); this table is the hub's own copy, capped so a hostile agent
// cannot flood D1.

import { QUOTAS } from "../quotas";
import { tenantDb, type TenantDb } from "./tenant";

export type AnnotationLevel = "notice" | "warning" | "failure";

/** An annotation of a frame that passed the shape check, as the agent sent it. */
export interface ValidAnnotation {
	path: string;
	line: number;
	level: AnnotationLevel;
	message: string;
	title?: string;
}

export interface AnnotationRow {
	id: number;
	installation_id: number;
	run_id: string;
	job: string;
	level: AnnotationLevel;
	path: string;
	start_line: number;
	end_line: number;
	title: string | null;
	message: string;
	/** Epoch ms the hub stored the row. */
	created_at: number;
}

/** Stored annotations of a run by level; total is their sum. */
export interface AnnotationCounts {
	failure: number;
	warning: number;
	notice: number;
	total: number;
}

const LEVELS: Record<string, true> = { notice: true, warning: true, failure: true };
/** The biggest line number kept; a line past it cannot be a real source line. */
const MAX_LINE = 10_000_000;

/**
 * The items of an annotations frame that have the shape the schema asks for: a non-empty path, a
 * line from 1 to MAX_LINE, a known level and a string message. Anything else is dropped, so one bad
 * item never fails the frame (a handler that throws closes the connection and the frame replays).
 */
export function validAnnotations(items: unknown): ValidAnnotation[] {
	if (!Array.isArray(items)) return [];
	const valid: ValidAnnotation[] = [];
	for (const item of items as Record<string, unknown>[]) {
		if (typeof item !== "object" || item === null) continue;
		const { path, line, level, message, title } = item;
		if (typeof path !== "string" || path === "" || typeof message !== "string") continue;
		if (typeof line !== "number" || !Number.isInteger(line) || line < 1 || line > MAX_LINE) continue;
		if (typeof level !== "string" || !Object.hasOwn(LEVELS, level)) continue;
		valid.push({ path, line, level: level as AnnotationLevel, message, ...(typeof title === "string" && title !== "" ? { title } : {}) });
	}
	return valid;
}

/** s cut to at most max characters (code points, so no surrogate pair is split). */
export function cutText(s: string, max: number): string {
	return s.length <= max ? s : Array.from(s).slice(0, max).join("");
}

/**
 * The statement is one INSERT ... SELECT so the caps hold even if two frames race: it counts the
 * job's and the run's stored rows itself and takes only as many items as still fit. It selects from
 * runs, so a run of another installation stores nothing. ?1 is the installation, ?2 the run, ?3 the
 * job, ?4 the time, ?5 the items as JSON, ?6 and ?7 the per job and per run caps.
 */
const INSERT_SQL = `INSERT INTO annotations (installation_id, run_id, job, level, path, start_line, end_line, title, message, created_at)
	SELECT ?1, r.run_id, ?3,
		json_extract(j.value, '$.level'), json_extract(j.value, '$.path'),
		json_extract(j.value, '$.line'), json_extract(j.value, '$.line'),
		json_extract(j.value, '$.title'), json_extract(j.value, '$.message'), ?4
	FROM runs r, json_each(?5) j
	WHERE r.installation_id = ?1 AND r.run_id = ?2
		AND j.key < min(
			?6 - (SELECT count(*) FROM annotations a WHERE a.installation_id = ?1 AND a.run_id = ?2 AND a.job = ?3),
			?7 - (SELECT count(*) FROM annotations a WHERE a.installation_id = ?1 AND a.run_id = ?2)
		)
	ORDER BY j.key`;

/**
 * Stores the annotations of one job of the installation's run: the first ones that fit under 50 per
 * job and 200 per run, with path, title and message cut to their limits. Returns how many rows were
 * stored; 0 when the run is not the installation's or the caps are used up.
 */
export async function insertAnnotations(t: TenantDb, runId: string, job: string, items: ValidAnnotation[], now: number): Promise<number> {
	if (items.length === 0) return 0;
	const rows = items.slice(0, QUOTAS.storedAnnotationsPerJob).map((item) => ({
		level: item.level,
		path: cutText(item.path, QUOTAS.storedAnnotationPathChars),
		line: item.line,
		title: item.title === undefined ? null : cutText(item.title, QUOTAS.storedAnnotationTitleChars),
		message: cutText(item.message, QUOTAS.storedAnnotationMessageChars),
	}));
	const res = await t.run(
		INSERT_SQL,
		runId,
		cutText(job, QUOTAS.storedAnnotationTitleChars),
		now,
		JSON.stringify(rows),
		QUOTAS.storedAnnotationsPerJob,
		QUOTAS.storedAnnotationsPerRun,
	);
	return res.meta.changes;
}

/**
 * The stored annotations of the installation's run, worst first: failures, then warnings, then
 * notices, each by path and line (insertion order breaks ties). At most 200 rows.
 */
export async function listRunAnnotations(db: D1Database, installationId: number, runId: string): Promise<AnnotationRow[]> {
	return tenantDb(db, installationId).all<AnnotationRow>(
		`SELECT * FROM annotations WHERE installation_id = ?1 AND run_id = ?2
		ORDER BY CASE level WHEN 'failure' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, path, start_line, id`,
		runId,
	);
}

/** How many annotations of the installation's run are stored, by level. */
export async function countRunAnnotations(db: D1Database, installationId: number, runId: string): Promise<AnnotationCounts> {
	const rows = await tenantDb(db, installationId).all<{ level: AnnotationLevel; n: number }>(
		"SELECT level, count(*) AS n FROM annotations WHERE installation_id = ?1 AND run_id = ?2 GROUP BY level",
		runId,
	);
	const counts: AnnotationCounts = { failure: 0, warning: 0, notice: 0, total: 0 };
	for (const { level, n } of rows) {
		counts[level] = n;
		counts.total += n;
	}
	return counts;
}
