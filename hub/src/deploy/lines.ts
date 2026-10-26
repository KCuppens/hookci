// A deploy as one line: the standalone badge of a deploy run, and the line
// per env the push's checks message folds in once its checks passed. Pure
// renderers plus the one loader that reads a push's deploys from D1.

import type { TenantDb } from "../db/tenant";
import type { Env } from "../env";
import { runPageLink, stableLogLink } from "../logs/links";
import { BADGE_EMOJI, escapeMrkdwn } from "../slack/badge";
import { S } from "../strings";

export type DeployState = "queued" | "running" | "rolling_back" | "succeeded" | "failed" | "cancelled" | "interrupted" | "superseded";

/** A deploy's state, or rejected when the agent did not start it. */
export type DeployLineState = DeployState | "rejected";

export type DeployBadgeState = {
	env: string;
	sha: string;
	state: DeployLineState;
	step?: string;
	/** 0-based, as the agent reports it. */
	stepIndex?: number;
	stepsTotal?: number;
	durationMs?: number;
	rolledBack?: boolean;
	logUrl?: string;
	/** The job the log link opens, for the failure reply's log tail. */
	logJob?: string;
	runId?: string;
	/** The dashboard run page of the deploy run. */
	runUrl?: string;
	attempt?: number;
	/** Why the agent rejected the trigger. */
	reason?: string;
};

export const RETRY_ACTION = "hookci_deploy_retry";

const SEP = " · ";

/** States a deploy is still moving in. */
export const DEPLOY_ACTIVE: Partial<Record<DeployLineState, true>> = { queued: true, running: true, rolling_back: true };

export const DEPLOY_EMOJI: Record<DeployLineState, string> = {
	queued: BADGE_EMOJI.running,
	running: BADGE_EMOJI.running,
	rolling_back: BADGE_EMOJI.running,
	succeeded: BADGE_EMOJI.success,
	failed: BADGE_EMOJI.failed,
	cancelled: BADGE_EMOJI.cancelled,
	interrupted: BADGE_EMOJI.interrupted,
	superseded: BADGE_EMOJI.superseded,
	rejected: BADGE_EMOJI.skipped,
};

/** The state in plain words: `Deploying`, `Deploy failed`, `Deploy not started`... */
export function deployTitle(state: DeployLineState): string {
	if (state === "rejected") return S.deploy.notStartedTitle;
	return S.deploy.checkTitle[state === "queued" || state === "rolling_back" ? "running" : state];
}

/** 2m04s from a minute on, 41s below. */
function deployDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	if (total < 60) return `${total}s`;
	return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

/** `2/5 build`: the 1-based step position and name, '' when unknown. */
export function position(s: DeployBadgeState): string {
	const at = s.stepIndex !== undefined && s.stepsTotal !== undefined ? `${s.stepIndex + 1}/${s.stepsTotal}` : "";
	return [at, s.step ?? ""].filter(Boolean).join(" ");
}

/** The line's parts after env (and sha), without the log link. */
function statusParts(s: DeployBadgeState): string[] {
	switch (s.state) {
		case "queued":
			return [S.deploy.queued];
		case "running":
			return [position(s) || S.slack.state.running];
		case "rolling_back":
			return [S.deploy.rollingBack];
		case "succeeded":
			return [...(s.durationMs !== undefined ? [deployDuration(s.durationMs)] : []), S.deploy.healthOk];
		case "failed": {
			const at = position(s);
			return [at ? S.deploy.failedAt(at) : S.slack.state.failed.toLowerCase(), ...(s.rolledBack ? [S.deploy.rolledBack] : [])];
		}
		case "cancelled":
		case "interrupted":
		case "superseded":
			return [S.deploy.stopped[s.state]];
		case "rejected":
			return [S.deploy.notStarted(s.reason ?? "")];
	}
}

function withLog(parts: string[], s: DeployBadgeState, link: boolean): string {
	const plain = parts.join(SEP);
	if (!s.logUrl) return link ? escapeMrkdwn(plain) : plain;
	return link ? `${escapeMrkdwn(plain)}${SEP}<${s.logUrl}|${S.badge.log}>` : `${plain}${SEP}${S.badge.log}`;
}

/** The standalone badge line: `staging · abc1234 · 3/8 migrate · log`; mrkdwn with the log linked when link. */
export function badgeLine(s: DeployBadgeState, link: boolean): string {
	return withLog([s.env, s.sha.slice(0, 7), ...statusParts(s)], s, link);
}

/** The env's line in the push's checks message, which already names the commit: `production · 2/5 build · log`. */
export function foldLine(s: DeployBadgeState, link: boolean): string {
	if (s.state === "superseded") {
		const plain = S.deploy.skippedNewerPush(s.env);
		return link ? escapeMrkdwn(plain) : plain;
	}
	return withLog([s.env, ...statusParts(s)], s, link);
}

/**
 * The header of a passed push's message with its deploys folded in, by the
 * most active, then the worst, state: Deploying while any env moves, then
 * Deploy failed, Deploy not started, Deploy cancelled or interrupted, and
 * Deployed once every env that was not skipped succeeded. null while every
 * deploy was skipped for a newer push: the message stays Passed.
 */
export function foldHeader(lines: readonly DeployBadgeState[]): { emoji: string; word: string } | null {
	const has = (state: DeployLineState) => lines.some((s) => s.state === state);
	const active = lines.filter((s) => DEPLOY_ACTIVE[s.state]);
	if (active.length > 0) return { emoji: DEPLOY_EMOJI.running, word: S.deploy.deploying(active.map((s) => s.env).join(", ")) };
	if (has("failed")) return { emoji: DEPLOY_EMOJI.failed, word: S.deploy.checkTitle.failed };
	if (has("rejected")) return { emoji: DEPLOY_EMOJI.rejected, word: S.deploy.notStartedTitle };
	if (has("cancelled")) return { emoji: DEPLOY_EMOJI.cancelled, word: S.deploy.checkTitle.cancelled };
	if (has("interrupted")) return { emoji: DEPLOY_EMOJI.interrupted, word: S.deploy.checkTitle.interrupted };
	const succeeded = lines.filter((s) => s.state === "succeeded");
	if (succeeded.length > 0) return { emoji: DEPLOY_EMOJI.succeeded, word: S.deploy.deployed(succeeded.map((s) => s.env).join(", ")) };
	return null;
}

type DeployLineRow = {
	env: string;
	attempt: number;
	status: "sent" | "accepted" | "rejected";
	reason: string | null;
	run_id: string | null;
	state: DeployState | null;
	step: string | null;
	step_index: number | null;
	steps_total: number | null;
	started_at: number | null;
	updated_at: number | null;
	rolled_back: number | null;
	run_state: string | null;
	duration_ms: number | null;
	log_job: string | null;
};

/** A deploy the agent has sent no event for yet, by its run's state. */
function stateBeforeEvents(runState: string | null): DeployState {
	switch (runState) {
		case "superseded":
			return "superseded";
		case "cancelled":
		case "skipped":
			return "cancelled";
		case "interrupted":
			return "interrupted";
		default:
			return "queued";
	}
}

/**
 * The latest attempt of each env's deploy chained by the checks run, as lines
 * by env: its render once the agent sent events, else what its trigger and
 * run say. sha is the checks run's commit, which its deploys share.
 */
export async function loadDeployLines(
	env: Pick<Env, "HUB_ORIGIN">,
	t: TenantDb,
	checksRunId: string,
	sha: string,
): Promise<DeployBadgeState[]> {
	const rows = await t.all<DeployLineRow>(
		`SELECT dt.env, dt.attempt, dt.status, dt.reason, dt.run_id, dr.state, dr.step, dr.step_index, dr.steps_total, dr.started_at, dr.updated_at,
			dr.rolled_back, r.state AS run_state, r.duration_ms, (SELECT MIN(j.name) FROM jobs j WHERE j.run_id = dt.run_id) AS log_job
		FROM deploy_triggers dt
		LEFT JOIN deploy_renders dr ON dr.installation_id = dt.installation_id AND dr.run_id = dt.run_id
		LEFT JOIN runs r ON r.installation_id = dt.installation_id AND r.trigger_id = dt.trigger_id
		WHERE dt.installation_id = ?1 AND dt.checks_run_id = ?2
			AND dt.attempt = (SELECT MAX(d2.attempt) FROM deploy_triggers d2
				WHERE d2.installation_id = dt.installation_id AND d2.checks_run_id = dt.checks_run_id AND d2.env = dt.env)
		ORDER BY dt.env`,
		checksRunId,
	);
	return rows.map((row) => {
		const state: DeployLineState = row.status === "rejected" ? "rejected" : (row.state ?? stateBeforeEvents(row.run_state));
		const terminal = state !== "rejected" && !DEPLOY_ACTIVE[state];
		const started = row.started_at !== null && row.updated_at !== null ? row.updated_at - row.started_at : undefined;
		const durationMs = row.duration_ms ?? started;
		return {
			env: row.env,
			sha,
			state,
			attempt: row.attempt,
			...(row.run_id !== null ? { runId: row.run_id, runUrl: runPageLink(env, t.installationId, row.run_id) } : {}),
			...(row.reason !== null ? { reason: row.reason } : {}),
			...(row.step !== null ? { step: row.step } : {}),
			...(row.step_index !== null ? { stepIndex: row.step_index } : {}),
			...(row.steps_total !== null ? { stepsTotal: row.steps_total } : {}),
			...(terminal && row.state !== null && durationMs !== undefined ? { durationMs } : {}),
			...(row.rolled_back ? { rolledBack: true } : {}),
			...(row.run_id !== null && row.log_job !== null ? { logUrl: stableLogLink(env, row.run_id, row.log_job), logJob: row.log_job } : {}),
		};
	});
}
