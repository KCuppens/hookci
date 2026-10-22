import { OPEN, type RunListRow, RUN_LIST_SELECT } from "./runs";
import type { TenantDb } from "./tenant";

const DAY_MS = 86_400_000;
const WINDOW_MS = 7 * DAY_MS;
/** Durations read per window for the median; the newest runs win when there are more. */
const MEDIAN_SAMPLE = 1000;

export interface RunFilter {
	/** The state to show, one of the stored run states. */
	state?: string;
	repoId?: number;
	/** A branch ref name as shown, without refs/heads/. */
	branch?: string;
	/** A hex prefix of the commit SHA. */
	sha?: string;
	/** The GitHub login of the commit author. */
	author?: string;
	agentId?: string;
	/** The triggering event, such as push or pull_request. */
	event?: string;
	/** Only runs started or finished at or after this time (ms), plus runs that are still open and have not started. */
	since?: number;
	/** Oldest first when set; newest first otherwise. */
	oldestFirst?: boolean;
}

/** The WHERE conditions for the filter; ?1 is the installation id, the returned binds start at ?2. */
function runWhere(filter: RunFilter): { where: string[]; binds: unknown[] } {
	const binds: unknown[] = [];
	const where = ["r.installation_id = ?1"];
	const bind = (value: unknown): string => {
		binds.push(value);
		return `?${binds.length + 1}`;
	};
	if (filter.state !== undefined) where.push(`r.state = ${bind(filter.state)}`);
	if (filter.repoId !== undefined) where.push(`r.repo_id = ${bind(filter.repoId)}`);
	if (filter.branch !== undefined) where.push(`(r.ref = ${bind(`refs/heads/${filter.branch}`)} OR r.ref = ${bind(filter.branch)})`);
	if (filter.sha !== undefined) where.push(`r.sha LIKE ${bind(`${filter.sha}%`)}`);
	if (filter.author !== undefined) where.push(`r.author_login = ${bind(filter.author)}`);
	if (filter.agentId !== undefined) where.push(`r.agent_id = ${bind(filter.agentId)}`);
	if (filter.event !== undefined) where.push(`r.event = ${bind(filter.event)}`);
	if (filter.since !== undefined) {
		where.push(`(COALESCE(r.started_at, r.finished_at) >= ${bind(filter.since)} OR (r.started_at IS NULL AND r.finished_at IS NULL AND r.${OPEN}))`);
	}
	return { where, binds };
}

/** At most limit runs matching every given filter, skipping the first offset, newest first unless the filter says oldest. */
export async function listRunsFiltered(t: TenantDb, limit: number, filter: RunFilter, offset = 0): Promise<RunListRow[]> {
	const { where, binds } = runWhere(filter);
	const order = filter.oldestFirst ? "ASC" : "DESC";
	const n = binds.length + 2;
	return t.all<RunListRow>(`${RUN_LIST_SELECT} WHERE ${where.join(" AND ")} ORDER BY r.rowid ${order} LIMIT ?${n} OFFSET ?${n + 1}`, ...binds, limit, offset);
}

/** How many of the installation's runs match every given filter. */
export async function countRunsFiltered(t: TenantDb, filter: RunFilter): Promise<number> {
	const { where, binds } = runWhere(filter);
	return (await t.first<{ n: number }>(`SELECT COUNT(*) AS n FROM runs r WHERE ${where.join(" AND ")}`, ...binds))?.n ?? 0;
}

/** The highest run rowid the installation has, 0 when it has no runs: what a page shows is current up to it. */
export async function newestRunRowid(t: TenantDb): Promise<number> {
	return (await t.first<{ n: number | null }>("SELECT MAX(rowid) AS n FROM runs WHERE installation_id = ?1"))?.n ?? 0;
}

/** How many runs matching the filter were recorded after the run whose rowid is after. */
export async function countRunsAfter(t: TenantDb, filter: RunFilter, after: number): Promise<number> {
	const { where, binds } = runWhere(filter);
	return (await t.first<{ n: number }>(`SELECT COUNT(*) AS n FROM runs r WHERE ${where.join(" AND ")} AND r.rowid > ?${binds.length + 2}`, ...binds, after))?.n ?? 0;
}

export interface RepoOption {
	repo_id: number;
	full_name: string;
}

/** The repositories the installation has runs for, by name, for the filter menu. */
export async function listRunRepos(t: TenantDb): Promise<RepoOption[]> {
	return t.all<RepoOption>(
		`SELECT p.repo_id, p.full_name FROM repos p
		WHERE p.installation_id = ?1 AND EXISTS (SELECT 1 FROM runs r WHERE r.installation_id = p.installation_id AND r.repo_id = p.repo_id)
		ORDER BY p.full_name`,
	);
}

/** The branches the installation has runs for (refs/heads/ stripped), by name; pull request refs are not listed. */
export async function listRunBranches(t: TenantDb): Promise<string[]> {
	const rows = await t.all<{ ref: string }>("SELECT DISTINCT ref FROM runs WHERE installation_id = ?1 AND pr_number IS NULL ORDER BY ref LIMIT 100");
	return rows.map((r) => (r.ref.startsWith("refs/heads/") ? r.ref.slice("refs/heads/".length) : r.ref));
}

/** The commit authors (GitHub logins) the installation has runs for, by name. */
export async function listRunAuthors(t: TenantDb): Promise<string[]> {
	const rows = await t.all<{ author_login: string }>("SELECT DISTINCT author_login FROM runs WHERE installation_id = ?1 AND author_login IS NOT NULL ORDER BY author_login LIMIT 100");
	return rows.map((r) => r.author_login);
}

export interface AgentOption {
	agent_id: string;
	name: string;
}

/** The agents that have run something for the installation, by name. */
export async function listRunAgents(t: TenantDb): Promise<AgentOption[]> {
	return t.all<AgentOption>(
		`SELECT a.agent_id, a.name FROM agents a
		WHERE a.installation_id = ?1 AND EXISTS (SELECT 1 FROM runs r WHERE r.installation_id = a.installation_id AND r.agent_id = a.agent_id)
		ORDER BY a.name`,
	);
}

/** The events (push, pull_request, ...) the installation has runs for. */
export async function listRunEvents(t: TenantDb): Promise<string[]> {
	const rows = await t.all<{ event: string }>("SELECT DISTINCT event FROM runs WHERE installation_id = ?1 ORDER BY event LIMIT 20");
	return rows.map((r) => r.event);
}

export interface BrokenWatch {
	repo_id: number;
	repo_name: string | null;
	broken_reason: string | null;
}

export interface OverviewData {
	gatedRuns: number;
	/** Runs counted against today's quota (UTC day). */
	runsToday: number;
	passed: number;
	failed: number;
	/** Median duration of the runs that finished in the last 7 days, null when none did. */
	medianMs: number | null;
	/** Median of the 7 days before that, null when none finished then. */
	previousMedianMs: number | null;
	brokenWatches: BrokenWatch[];
	/** Runs in running or verifying, by agent_id. */
	runningByAgent: Record<string, number>;
	setup: { agents: number; bindings: number; slack: number; configuredRuns: number };
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

async function count(t: TenantDb, sql: string, ...binds: unknown[]): Promise<number> {
	return (await t.first<{ n: number }>(sql, ...binds))?.n ?? 0;
}

async function durations(t: TenantDb, from: number, to: number): Promise<number[]> {
	const rows = await t.all<{ duration_ms: number }>(
		`SELECT duration_ms FROM runs WHERE installation_id = ?1 AND duration_ms IS NOT NULL AND state IN ('success', 'failed')
		AND finished_at >= ?2 AND finished_at < ?3 ORDER BY finished_at DESC LIMIT ${MEDIAN_SAMPLE}`,
		from,
		to,
	);
	return rows.map((r) => r.duration_ms);
}

/** Everything the overview page shows, each figure from stored rows of the installation. */
export async function getOverview(t: TenantDb, now: number): Promise<OverviewData> {
	const day = new Date(now).toISOString().slice(0, 10);
	const since = now - WINDOW_MS;
	const outcomes = await t.all<{ state: string; n: number }>(
		"SELECT state, COUNT(*) AS n FROM runs WHERE installation_id = ?1 AND state IN ('success', 'failed') AND finished_at >= ?2 GROUP BY state",
		since,
	);
	const running = await t.all<{ agent_id: string; n: number }>(
		"SELECT agent_id, COUNT(*) AS n FROM runs WHERE installation_id = ?1 AND agent_id IS NOT NULL AND state IN ('running', 'verifying') GROUP BY agent_id",
	);
	const brokenWatches = await t.all<BrokenWatch>(
		`SELECT w.repo_id, p.full_name AS repo_name, w.broken_reason FROM watches w
		LEFT JOIN repos p ON p.installation_id = w.installation_id AND p.repo_id = w.repo_id
		WHERE w.installation_id = ?1 AND w.status = 'broken' ORDER BY w.repo_id LIMIT 20`,
	);
	return {
		gatedRuns: await count(t, "SELECT COUNT(*) AS n FROM runs WHERE installation_id = ?1 AND state = 'gated'"),
		runsToday: await count(t, "SELECT COALESCE(SUM(runs), 0) AS n FROM daily_counters WHERE installation_id = ?1 AND day = ?2", day),
		passed: outcomes.find((o) => o.state === "success")?.n ?? 0,
		failed: outcomes.find((o) => o.state === "failed")?.n ?? 0,
		medianMs: median(await durations(t, since, now + 1)),
		previousMedianMs: median(await durations(t, since - WINDOW_MS, since)),
		brokenWatches,
		runningByAgent: Object.fromEntries(running.map((r) => [r.agent_id, r.n])),
		setup: {
			agents: await count(t, "SELECT COUNT(*) AS n FROM agents WHERE installation_id = ?1 AND status != 'revoked'"),
			bindings: await count(t, "SELECT COUNT(*) AS n FROM repo_bindings WHERE installation_id = ?1"),
			slack: await count(t, "SELECT COUNT(*) AS n FROM workspace_links WHERE installation_id = ?1"),
			configuredRuns: await count(t, "SELECT COUNT(*) AS n FROM runs WHERE installation_id = ?1 AND state != 'skipped'"),
		},
	};
}
