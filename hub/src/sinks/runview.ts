// Builds the RunView sinks receive from the runs, jobs and repos rows.

import type { JobRow, RunRow } from "../db/runs";
import { tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { HubError } from "../errors";
import { stableLogLink } from "../logs/links";
import type { JobView, PendingReason, RunState, RunView } from "./types";

const RUN_STATES: Record<RunState, true> = {
	received: true,
	gated: true,
	pending: true,
	superseded: true,
	queued: true,
	running: true,
	success: true,
	failed: true,
	cancelled: true,
	skipped: true,
	interrupted: true,
	verifying: true,
	rolling_back: true,
};

const PENDING_REASONS: Record<PendingReason, true> = {
	no_agent: true,
	agent_offline: true,
	daily_cap: true,
	fork_gated: true,
	fork_never: true,
	suspended: true,
	no_config: true,
};

function runState(state: string): RunState {
	if (Object.hasOwn(RUN_STATES, state)) return state as RunState;
	throw new HubError("bad_run_state", 500, `unknown run state ${state}`);
}

/**
 * The run with its jobs, by run_id (the trigger_id until the agent accepts) or by trigger_id; null when not this installation's.
 * A job whose log was uploaded gets its stable log link.
 */
export async function loadRunView(
	env: Pick<Env, "DB" | "HUB_ORIGIN">,
	installationId: number,
	key: { runId: string } | { triggerId: string },
): Promise<RunView | null> {
	const t = tenantDb(env.DB, installationId);
	const select = `SELECT r.*, p.full_name FROM runs r
		LEFT JOIN repos p ON p.installation_id = r.installation_id AND p.repo_id = r.repo_id
		WHERE r.installation_id = ?1`;
	const run =
		"runId" in key
			? await t.first<RunRow & { full_name: string | null }>(`${select} AND r.run_id = ?2`, key.runId)
			: await t.first<RunRow & { full_name: string | null }>(`${select} AND r.trigger_id = ?2 ORDER BY r.rowid DESC LIMIT 1`, key.triggerId);
	if (!run) return null;
	if (run.event !== "pull_request" && run.event !== "push") throw new HubError("bad_run_event", 500, `unknown run event ${run.event}`);
	const jobs = await t.all<JobRow & { log_key: string | null }>(
		"SELECT j.* FROM jobs j JOIN runs r ON r.run_id = j.run_id WHERE r.installation_id = ?1 AND j.run_id = ?2 ORDER BY j.rowid",
		run.run_id,
	);
	return {
		installationId,
		repoId: run.repo_id,
		repo: run.full_name ?? "",
		triggerId: run.trigger_id,
		runId: run.run_id === run.trigger_id ? undefined : run.run_id,
		sha: run.sha,
		shortSha: run.sha.slice(0, 7),
		ref: run.ref,
		event: run.event,
		prNumber: run.pr_number ?? undefined,
		target: run.env === null ? "checks" : `deploy:${run.env}`,
		state: runState(run.state),
		reason: run.reason !== null && Object.hasOwn(PENDING_REASONS, run.reason) ? (run.reason as PendingReason) : undefined,
		trustRefused: run.trust_refused ?? undefined,
		commitTitle: run.commit_title ?? "",
		authorLogin: run.author_login ?? "",
		startedAt: run.started_at ?? undefined,
		finishedAt: run.finished_at ?? undefined,
		durationMs: run.duration_ms ?? undefined,
		jobs: jobs.map((job) => ({
			name: job.name,
			state: runState(job.state),
			durationMs: job.duration_ms ?? undefined,
			step: job.step ?? undefined,
			stepIndex: job.step_index ?? undefined,
			stepsTotal: job.steps_total ?? undefined,
			logLink: job.log_key === null ? undefined : stableLogLink(env, run.run_id, job.name),
		})),
		currentJob: jobs.find((job) => job.state === "running")?.name,
		slack:
			run.slack_channel === null
				? undefined
				: { channel: run.slack_channel, notify: run.slack_notify ?? undefined, alert: run.slack_alert ?? undefined },
	};
}

/** The job whose log a run message links: the first failed job with a log, else the first job with one. */
export function logJob(run: RunView): JobView | undefined {
	return run.jobs.find((job) => job.state === "failed" && job.logLink) ?? run.jobs.find((job) => job.logLink);
}
