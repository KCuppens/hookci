import type { JobPlanned } from "../protocol";
import type { TenantDb } from "./tenant";
import type { WatchRow } from "./watches";

export interface RunRow {
	run_id: string;
	installation_id: number;
	repo_id: number;
	sha: string;
	ref: string;
	event: string;
	pr_number: number | null;
	env: string | null;
	attempt: number;
	trigger_id: string;
	agent_id: string | null;
	state: string;
	reason: string | null;
	author_login: string | null;
	commit_title: string | null;
	started_at: number | null;
	finished_at: number | null;
	duration_ms: number | null;
	log_key: string | null;
	/** The .zeroci.yml notify.slack channel name, without the leading #. */
	slack_channel: string | null;
	slack_notify: WatchRow["notify"] | null;
	slack_alert: WatchRow["alert"] | null;
}

export interface JobRow {
	run_id: string;
	name: string;
	state: string;
	step: string | null;
	step_index: number | null;
	steps_total: number | null;
	duration_ms: number | null;
}

export type NewRun = Omit<RunRow, "installation_id" | "slack_channel" | "slack_notify" | "slack_alert">;

const SLACK_NOTIFY: Record<string, WatchRow["notify"]> = { quiet: "quiet", normal: "normal", verbose: "normal" };
const SLACK_ALERT: Record<string, WatchRow["alert"]> = { channel: "channel", dm: "dm" };

/** Columns updateRunState may set besides state; a key given as null clears the column. */
export type RunPatch = Partial<Pick<RunRow, "reason" | "agent_id" | "started_at" | "finished_at" | "duration_ms" | "log_key">>;

const PATCH_COLUMNS = ["reason", "agent_id", "started_at", "finished_at", "duration_ms", "log_key"] as const satisfies readonly (keyof RunPatch)[];

export async function insertRun(t: TenantDb, row: NewRun): Promise<void> {
	await t.run(
		`INSERT INTO runs (installation_id, run_id, repo_id, sha, ref, event, pr_number, env, attempt, trigger_id, agent_id, state, reason,
			author_login, commit_title, started_at, finished_at, duration_ms, log_key)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
		row.run_id,
		row.repo_id,
		row.sha,
		row.ref,
		row.event,
		row.pr_number,
		row.env,
		row.attempt,
		row.trigger_id,
		row.agent_id,
		row.state,
		row.reason,
		row.author_login,
		row.commit_title,
		row.started_at,
		row.finished_at,
		row.duration_ms,
		row.log_key,
	);
}

/**
 * Stores the run's .zeroci.yml notify.slack override as the agent sent it on
 * job_planned: the channel without its # and lowercased as Slack names are,
 * YAML verbose as normal, and a notify or alert value the hub does not know
 * as unset.
 */
export async function setRunSlackOverride(t: TenantDb, runId: string, slack: NonNullable<JobPlanned["slack"]>): Promise<void> {
	await t.run(
		"UPDATE runs SET slack_channel = ?3, slack_notify = ?4, slack_alert = ?5 WHERE installation_id = ?1 AND run_id = ?2",
		runId,
		slack.channel.replace(/^#/, "").toLowerCase(),
		slack.notify !== undefined && Object.hasOwn(SLACK_NOTIFY, slack.notify) ? (SLACK_NOTIFY[slack.notify] ?? null) : null,
		slack.alert !== undefined && Object.hasOwn(SLACK_ALERT, slack.alert) ? (SLACK_ALERT[slack.alert] ?? null) : null,
	);
}

/** Whether any run, of any event or attempt, exists for the commit in the repo. */
export async function hasRunForSha(t: TenantDb, repoId: number, sha: string): Promise<boolean> {
	return (await t.first("SELECT 1 FROM runs WHERE installation_id = ?1 AND repo_id = ?2 AND sha = ?3 LIMIT 1", repoId, sha)) !== null;
}

/** Sets the run state and the patched columns; false when the run is not this installation's. */
export async function updateRunState(t: TenantDb, runId: string, state: string, patch: RunPatch = {}): Promise<boolean> {
	const set = ["state = ?3"];
	const binds: unknown[] = [runId, state];
	for (const column of PATCH_COLUMNS) {
		const value = patch[column];
		if (value === undefined) continue;
		binds.push(value);
		set.push(`${column} = ?${binds.length + 1}`);
	}
	const res = await t.run(`UPDATE runs SET ${set.join(", ")} WHERE installation_id = ?1 AND run_id = ?2`, ...binds);
	return res.meta.changes > 0;
}

/**
 * Gives the run the agent's run_id in place of its provisional one (the
 * trigger_id). A run still waiting (received, queued or pending) becomes
 * queued with no reason; any other state is kept. False when no such run.
 */
export async function acceptRun(t: TenantDb, provisionalRunId: string, runId: string, agentId: string): Promise<boolean> {
	const res = await t.run(
		`UPDATE runs SET run_id = ?3, agent_id = ?4,
			reason = CASE WHEN state IN ('received', 'queued', 'pending') THEN NULL ELSE reason END,
			state = CASE WHEN state IN ('received', 'queued', 'pending') THEN 'queued' ELSE state END
		WHERE installation_id = ?1 AND run_id = ?2`,
		provisionalRunId,
		runId,
		agentId,
	);
	return res.meta.changes > 0;
}

/** Moves a run the agent has not started (received or queued) to pending with reason; false when it was not waiting. */
export async function markRunPending(t: TenantDb, runId: string, reason: string): Promise<boolean> {
	const res = await t.run(
		"UPDATE runs SET state = 'pending', reason = ?3 WHERE installation_id = ?1 AND run_id = ?2 AND state IN ('received', 'queued')",
		runId,
		reason,
	);
	return res.meta.changes > 0;
}

/** Cancels every pending run of the installation, finishing them at. */
export async function cancelPendingRuns(t: TenantDb, at: number): Promise<void> {
	await t.run("UPDATE runs SET state = 'cancelled', finished_at = ?2 WHERE installation_id = ?1 AND state = 'pending'", at);
}

/**
 * Inserts or updates a job of one of this installation's runs; false when the
 * run is not this installation's. Progress columns given as null keep their
 * stored value.
 */
export async function upsertJob(t: TenantDb, job: JobRow): Promise<boolean> {
	const res = await t.run(
		`INSERT INTO jobs (run_id, name, state, step, step_index, steps_total, duration_ms)
		SELECT run_id, ?3, ?4, ?5, ?6, ?7, ?8 FROM runs WHERE installation_id = ?1 AND run_id = ?2
		ON CONFLICT (run_id, name) DO UPDATE SET state = excluded.state,
			step = coalesce(excluded.step, step), step_index = coalesce(excluded.step_index, step_index),
			steps_total = coalesce(excluded.steps_total, steps_total), duration_ms = coalesce(excluded.duration_ms, duration_ms)`,
		job.run_id,
		job.name,
		job.state,
		job.step,
		job.step_index,
		job.steps_total,
		job.duration_ms,
	);
	return res.meta.changes > 0;
}

export async function getRun(t: TenantDb, runId: string): Promise<RunRow | null> {
	return t.first<RunRow>("SELECT * FROM runs WHERE installation_id = ?1 AND run_id = ?2", runId);
}

/** The installation's most recently recorded runs, newest first. */
export async function listRecentRuns(t: TenantDb, limit = 10): Promise<RunRow[]> {
	return t.all<RunRow>("SELECT * FROM runs WHERE installation_id = ?1 ORDER BY rowid DESC LIMIT ?2", limit);
}

/** The repo's latest run, of the commit whose SHA starts with shaPrefix when given; null when none. */
export async function findLatestRun(t: TenantDb, repoId: number, shaPrefix?: string): Promise<RunRow | null> {
	if (shaPrefix === undefined) {
		return t.first<RunRow>("SELECT * FROM runs WHERE installation_id = ?1 AND repo_id = ?2 ORDER BY rowid DESC LIMIT 1", repoId);
	}
	return t.first<RunRow>(
		"SELECT * FROM runs WHERE installation_id = ?1 AND repo_id = ?2 AND substr(sha, 1, length(?3)) = lower(?3) ORDER BY rowid DESC LIMIT 1",
		repoId,
		shaPrefix,
	);
}

/** The repo's most recently recorded runs, newest first. */
export async function listRecentRunsForRepo(t: TenantDb, repoId: number, limit: number): Promise<RunRow[]> {
	return t.all<RunRow>("SELECT * FROM runs WHERE installation_id = ?1 AND repo_id = ?2 ORDER BY rowid DESC LIMIT ?3", repoId, limit);
}

/** The latest run recorded for a trigger. */
export async function findRunByTrigger(t: TenantDb, triggerId: string): Promise<RunRow | null> {
	return t.first<RunRow>(
		"SELECT * FROM runs WHERE installation_id = ?1 AND trigger_id = ?2 ORDER BY rowid DESC LIMIT 1",
		triggerId,
	);
}
