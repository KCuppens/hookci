import { HubError } from "../errors";
import type { JobPlanned } from "../protocol";
import type { TrustRefusal } from "../policy/trust";
import { TERMINAL } from "../slack/badge";
import type { TenantDb } from "./tenant";
import type { WatchRow } from "./watches";

/** `state NOT IN (...)` for runs that may still change. */
export const OPEN = `state NOT IN (${[...TERMINAL].map((s) => `'${s}'`).join(", ")})`;

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
	/** The .hookci.yml notify.slack channel name, without the leading #. */
	slack_channel: string | null;
	slack_notify: WatchRow["notify"] | null;
	slack_alert: WatchRow["alert"] | null;
	/** Why the base ref's `trust: all` was refused for this gated fork run; null when nothing was refused. */
	trust_refused: TrustRefusal | null;
	/** When the hub recorded the run, in epoch ms; 0 only for a run whose trigger_id is not a ULID. */
	created_at: number;
	/** The run's 1-based position among its installation's runs in the order they were recorded; shown as Run #N. */
	run_number: number;
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

export type NewRun = Omit<RunRow, "installation_id" | "slack_channel" | "slack_notify" | "slack_alert" | "trust_refused" | "created_at" | "run_number"> &
	Partial<Pick<RunRow, "trust_refused">>;

const SLACK_NOTIFY: Record<string, WatchRow["notify"]> = { quiet: "quiet", normal: "normal", verbose: "normal" };
const SLACK_ALERT: Record<string, WatchRow["alert"]> = { channel: "channel", dm: "dm" };

/** Columns updateRunState may set besides state; a key given as null clears the column. */
export type RunPatch = Partial<Pick<RunRow, "reason" | "agent_id" | "started_at" | "finished_at" | "duration_ms" | "log_key">>;

const PATCH_COLUMNS = ["reason", "agent_id", "started_at", "finished_at", "duration_ms", "log_key"] as const satisfies readonly (keyof RunPatch)[];

/** How many times insertRun tries to give a run its number before it lets the collision through. */
const NUMBER_ATTEMPTS = 3;

const RUN_NUMBER_COLLISION = /UNIQUE constraint failed: runs\.installation_id, runs\.run_number/;

/**
 * Records a run created at `at` (epoch ms) as the installation's next one: its
 * run_number is one more than the highest the installation has, read and
 * written by one INSERT so runs created at once get different numbers. The
 * unique index on (installation_id, run_number) makes a collision that still
 * happens fail instead of repeating a number, and then the insert is tried
 * again; any other error, and a collision on the last attempt, is thrown.
 */
export async function insertRun(t: TenantDb, row: NewRun, at: number = Date.now()): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await t.run(
				`INSERT INTO runs (installation_id, run_id, repo_id, sha, ref, event, pr_number, env, attempt, trigger_id, agent_id, state, reason,
					author_login, commit_title, started_at, finished_at, duration_ms, log_key, trust_refused, created_at, run_number)
				SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, COALESCE(MAX(run_number), 0) + 1
				FROM runs WHERE installation_id = ?1`,
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
				row.trust_refused ?? null,
				at,
			);
			return;
		} catch (err) {
			if (attempt >= NUMBER_ATTEMPTS || !RUN_NUMBER_COLLISION.test(String(err))) throw err;
		}
	}
}

/**
 * Stores the run's .hookci.yml notify.slack override as the agent sent it on
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

/** Sets the state and the patched columns of a run not yet finished; false when no such run of this installation. */
export async function updateRunState(t: TenantDb, runId: string, state: string, patch: RunPatch = {}): Promise<boolean> {
	const set = ["state = ?3"];
	const binds: unknown[] = [runId, state];
	for (const column of PATCH_COLUMNS) {
		const value = patch[column];
		if (value === undefined) continue;
		binds.push(value);
		set.push(`${column} = ?${binds.length + 1}`);
	}
	const res = await t.run(`UPDATE runs SET ${set.join(", ")} WHERE installation_id = ?1 AND run_id = ?2 AND ${OPEN}`, ...binds);
	return res.meta.changes > 0;
}

/** Marks the run of triggerId superseded, whatever its run_id is now, unless it already finished. */
export async function supersedeRun(t: TenantDb, triggerId: string, at: number): Promise<boolean> {
	const res = await t.run(
		`UPDATE runs SET state = 'superseded', finished_at = ?3 WHERE installation_id = ?1 AND trigger_id = ?2 AND ${OPEN}`,
		triggerId,
		at,
	);
	return res.meta.changes > 0;
}

/** Agent run ids: 1 to 64 letters, digits, dots, dashes or underscores, never "." or "..". */
export function isRunId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value) && value !== "." && value !== "..";
}

type RunClaim = Pick<RunRow, "installation_id" | "trigger_id" | "agent_id" | "repo_id" | "sha" | "env" | "attempt">;

/**
 * Gives the run of triggerId the agent's run_id in place of its provisional
 * one (the trigger_id); a second call with the same ids changes nothing more.
 * A run still waiting (received, queued or pending) becomes queued with no
 * reason; any other state is kept. When runId is already an earlier
 * attempt's run of the same deploy (same agent, repo, commit and env, a
 * lower attempt), that run is reopened as queued for triggerId and the
 * provisional row is dropped. Throws bad_run_id (400) for a malformed runId
 * and run_id_taken (409) when runId names any other run, of this
 * installation or another; both before any write. False when no such run.
 */
export async function acceptRun(t: TenantDb, triggerId: string, runId: string, agentId: string): Promise<boolean> {
	if (!isRunId(runId)) throw new HubError("bad_run_id", 400, `run id ${JSON.stringify(runId)} is not a valid run id`);
	// Unscoped: run_id is unique across installations, and another tenant's run must refuse the id, not fail the insert.
	const existing = await t.db
		.prepare("SELECT installation_id, trigger_id, agent_id, repo_id, sha, env, attempt FROM runs WHERE run_id = ?1")
		.bind(runId)
		.first<RunClaim>();
	if (existing && existing.installation_id !== t.installationId) {
		throw new HubError("run_id_taken", 409, `run id ${runId} belongs to another installation`);
	}
	if (existing && runId !== triggerId) {
		if (existing.trigger_id !== triggerId) {
			const provisional = await t.first<RunClaim>(
				"SELECT installation_id, trigger_id, agent_id, repo_id, sha, env, attempt FROM runs WHERE installation_id = ?1 AND run_id = ?2 AND trigger_id = ?2",
				triggerId,
			);
			// Only a deploy retry reuses a run id: the same agent, repo, commit and env, at a later attempt.
			const retry =
				provisional !== null &&
				provisional.env !== null &&
				provisional.env === existing.env &&
				provisional.agent_id === agentId &&
				existing.agent_id === agentId &&
				provisional.repo_id === existing.repo_id &&
				provisional.sha === existing.sha &&
				provisional.attempt > existing.attempt;
			if (!retry) {
				throw new HubError("run_id_taken", 409, `run id ${runId} is another run's, not an earlier attempt of trigger ${triggerId}`);
			}
			await t.run(
				`UPDATE runs SET trigger_id = ?3, agent_id = ?4, state = 'queued', reason = NULL, started_at = NULL, finished_at = NULL, duration_ms = NULL, attempt = ?5
				WHERE installation_id = ?1 AND run_id = ?2`,
				runId,
				triggerId,
				agentId,
				provisional.attempt,
			);
		}
		await t.run("DELETE FROM runs WHERE installation_id = ?1 AND run_id = ?2 AND trigger_id = ?2", triggerId);
		return true;
	}
	const res = await t.run(
		`UPDATE runs SET run_id = ?3, agent_id = ?4,
			reason = CASE WHEN state IN ('received', 'queued', 'pending') THEN NULL ELSE reason END,
			state = CASE WHEN state IN ('received', 'queued', 'pending') THEN 'queued' ELSE state END
		WHERE installation_id = ?1 AND trigger_id = ?2`,
		triggerId,
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

/** Cancels every run of the installation that has not finished, finishing them at. */
export async function cancelOpenRuns(t: TenantDb, at: number): Promise<void> {
	await t.run(`UPDATE runs SET state = 'cancelled', finished_at = ?2 WHERE installation_id = ?1 AND ${OPEN}`, at);
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

/** The job named name of the installation's run runId, or null. */
export async function getJob(t: TenantDb, runId: string, name: string): Promise<JobRow | null> {
	return t.first<JobRow>(
		`SELECT j.run_id, j.name, j.state, j.step, j.step_index, j.steps_total, j.duration_ms
		FROM jobs j JOIN runs r ON r.run_id = j.run_id WHERE r.installation_id = ?1 AND j.run_id = ?2 AND j.name = ?3`,
		runId,
		name,
	);
}

/** The names of the jobs recorded for the installation's run runId. */
export async function listJobNames(t: TenantDb, runId: string): Promise<string[]> {
	const rows = await t.all<{ name: string }>(
		"SELECT j.name FROM jobs j JOIN runs r ON r.run_id = j.run_id WHERE r.installation_id = ?1 AND j.run_id = ?2",
		runId,
	);
	return rows.map((r) => r.name);
}

/** The most recently recorded runs of the installation's repos repoIds, newest first. */
export async function listRecentRuns(t: TenantDb, repoIds: number[], limit: number): Promise<RunRow[]> {
	return t.all<RunRow>(
		"SELECT * FROM runs WHERE installation_id = ?1 AND repo_id IN (SELECT value FROM json_each(?2)) ORDER BY rowid DESC LIMIT ?3",
		JSON.stringify(repoIds),
		limit,
	);
}

/** The installation's repos with at least one recorded run. */
export async function listRunRepoIds(t: TenantDb): Promise<number[]> {
	return (await t.all<{ repo_id: number }>("SELECT DISTINCT repo_id FROM runs WHERE installation_id = ?1")).map((r) => r.repo_id);
}

/** A run with the names the dashboard shows; null when the repo is no longer shared with the app or the run has no agent. */
export interface RunListRow extends RunRow {
	/** The run's rowid: runs are listed newest first by it, and the next page starts below the last one's. */
	run_rowid: number;
	repo_name: string | null;
	agent_name: string | null;
}

export const RUN_LIST_SELECT = `SELECT r.*, r.rowid AS run_rowid, p.full_name AS repo_name, a.name AS agent_name FROM runs r
	LEFT JOIN repos p ON p.installation_id = r.installation_id AND p.repo_id = r.repo_id
	LEFT JOIN agents a ON a.installation_id = r.installation_id AND a.agent_id = r.agent_id`;

/** At most limit runs, newest first, recorded before the run whose rowid is before; the newest when before is omitted. */
export async function listRunsPage(t: TenantDb, limit: number, before?: number): Promise<RunListRow[]> {
	return t.all<RunListRow>(
		`${RUN_LIST_SELECT} WHERE r.installation_id = ?1 AND r.rowid < ?2 ORDER BY r.rowid DESC LIMIT ?3`,
		before ?? Number.MAX_SAFE_INTEGER,
		limit,
	);
}

export async function getRunListRow(t: TenantDb, runId: string): Promise<RunListRow | null> {
	return t.first<RunListRow>(`${RUN_LIST_SELECT} WHERE r.installation_id = ?1 AND r.run_id = ?2`, runId);
}

/** A job with where its finished log is stored: log_key is null until the agent uploads it. */
export interface JobLogRow extends JobRow {
	log_key: string | null;
	log_bytes: number | null;
	log_truncated: number;
	/** 1 when the repo keeps its logs on the agent (`logs: local`): nothing is uploaded. */
	logs_local: number;
}

/** The run's jobs in the order they were planned; empty when the run is not this installation's. */
export async function listJobsOfRun(t: TenantDb, runId: string): Promise<JobLogRow[]> {
	return t.all<JobLogRow>(
		"SELECT j.* FROM jobs j JOIN runs r ON r.run_id = j.run_id WHERE r.installation_id = ?1 AND j.run_id = ?2 ORDER BY j.rowid",
		runId,
	);
}

/** One job of the run, or null when the run is not this installation's or has no such job. */
export async function getJobOfRun(t: TenantDb, runId: string, job: string): Promise<JobLogRow | null> {
	return t.first<JobLogRow>(
		"SELECT j.* FROM jobs j JOIN runs r ON r.run_id = j.run_id WHERE r.installation_id = ?1 AND j.run_id = ?2 AND j.name = ?3",
		runId,
		job,
	);
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

type RunOwner = Pick<RunRow, "installation_id" | "agent_id" | "repo_id">;

/** The installation, agent and repo of a run, unscoped like getAgentByCredentialHash: callers prove access before using it. */
export async function getRunOwner(db: D1Database, runId: string): Promise<RunOwner | null> {
	return db.prepare("SELECT installation_id, agent_id, repo_id FROM runs WHERE run_id = ?1").bind(runId).first<RunOwner>();
}

/** Records where a job's log is stored; false when the job is not one of this installation's. */
export async function setJobLog(t: TenantDb, runId: string, job: string, log: { key: string; bytes: number; truncated: boolean }): Promise<boolean> {
	const res = await t.run(
		`UPDATE jobs SET log_key = ?4, log_bytes = ?5, log_truncated = ?6
		WHERE run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1 AND run_id = ?2) AND name = ?3`,
		runId,
		job,
		log.key,
		log.bytes,
		log.truncated ? 1 : 0,
	);
	return res.meta.changes > 0;
}

/** Records that the agent keeps a job's log on its own host; false when the job is not one of this installation's. */
export async function markJobLogsLocal(t: TenantDb, runId: string, job: string): Promise<boolean> {
	const res = await t.run(
		"UPDATE jobs SET logs_local = 1 WHERE run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1 AND run_id = ?2) AND name = ?3",
		runId,
		job,
	);
	return res.meta.changes > 0;
}
