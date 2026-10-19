import type { TenantDb } from "./tenant";

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

export type NewRun = Omit<RunRow, "installation_id">;

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

/** The latest run recorded for a trigger. */
export async function findRunByTrigger(t: TenantDb, triggerId: string): Promise<RunRow | null> {
	return t.first<RunRow>(
		"SELECT * FROM runs WHERE installation_id = ?1 AND trigger_id = ?2 ORDER BY rowid DESC LIMIT 1",
		triggerId,
	);
}
