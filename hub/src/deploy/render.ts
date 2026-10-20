// How a deploy run shows up: one Slack badge per run (posted once, then
// updated in place), a failure alert when the deploy ends failed, and an
// informational `zeroci/deploy:<env>` check run. Deploys never touch GitHub
// Deployments. Every sink failure is reported and swallowed here, so the
// agent's event handler never sees it.

import { getRepoByFullName } from "../db/repos";
import { tenantDb } from "../db/tenant";
import { listWatchesForRepo } from "../db/watches";
import { systemClock } from "../do/clock";
import { HubError } from "../errors";
import type { Env } from "../env";
import { createCheckRun, updateCheckRun } from "../github/api";
import { GitHubClient } from "../github/client";
import { defaultFetcher } from "../http";
import { signLogUrl } from "../logs/sign";
import { reportError } from "../observability";
import type { Event as AgentEvent } from "../protocol";
import { escapeMrkdwn } from "../slack/badge";
import { actions, type Block, button, context, section } from "../slack/blocks";
import { slackApi, slackApiFireAndForget } from "../slack/api";
import { tailBlock } from "../slack/messages";
import { S } from "../strings";
import type { DeployTriggerRow } from "./chain";

export type DeployState = "queued" | "running" | "rolling_back" | "succeeded" | "failed";

export type DeployBadgeState = {
	env: string;
	sha: string;
	state: DeployState;
	step?: string;
	/** 0-based, as the agent reports it. */
	stepIndex?: number;
	stepsTotal?: number;
	durationMs?: number;
	rolledBack?: boolean;
	logUrl?: string;
	runId?: string;
	attempt?: number;
};

export interface DeployRenderRow {
	run_id: string;
	repo: string;
	env: string;
	sha: string;
	slack_channel: string | null;
	slack_ts: string | null;
	check_run_id: number | null;
	state: DeployState;
	step: string | null;
	step_index: number | null;
	steps_total: number | null;
	started_at: number;
	updated_at: number;
}

const SEP = " · ";
const RETRY_ACTION = "zeroci_deploy_retry";

/** 2m04s from a minute on, 41s below. */
function deployDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	if (total < 60) return `${total}s`;
	return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

function position(s: DeployBadgeState): string {
	const at = s.stepIndex !== undefined && s.stepsTotal !== undefined ? `${s.stepIndex + 1}/${s.stepsTotal}` : "";
	return [at, s.step ?? ""].filter(Boolean).join(" ");
}

/** The badge's parts after env and sha, without the log link. */
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
		case "failed":
			return [S.deploy.failedAt(position(s) || S.slack.state.failed.toLowerCase()), ...(s.rolledBack ? [S.deploy.rolledBack] : [])];
	}
}

function badgeLine(s: DeployBadgeState, link: boolean): string {
	const parts = [s.env, s.sha.slice(0, 7), ...statusParts(s)];
	const plain = parts.join(SEP);
	if (!s.logUrl) return link ? escapeMrkdwn(plain) : plain;
	return link ? `${escapeMrkdwn(plain)}${SEP}<${s.logUrl}|${S.badge.log}>` : `${plain}${SEP}${S.badge.log}`;
}

/** The deploy run's Slack message; a failed deploy gets a Retry button. */
export function renderDeployBadge(s: DeployBadgeState): { text: string; blocks: unknown[] } {
	const blocks: Block[] = [section(badgeLine(s, true))];
	if (s.state === "failed" && s.runId !== undefined && s.attempt !== undefined) {
		blocks.push(actions(button(RETRY_ACTION, S.deploy.retry, `${s.runId}:${s.attempt}`)));
	}
	return { text: badgeLine(s, false), blocks };
}

/** The failure alert: the author's mention (or plain login), the badge line, the last log lines and the log link. */
export function renderDeployAlert(s: DeployBadgeState, tail: string[], mention: string): { text: string; blocks: unknown[] } {
	const blocks: Block[] = [section(`${mention ? `${mention} ` : ""}${badgeLine({ ...s, logUrl: undefined }, true)}`)];
	if (tail.length > 0) blocks.push(section(tailBlock(tail)));
	else blocks.push(context(S.slack.alertNoTail));
	if (s.logUrl) blocks.push(context(`<${s.logUrl}|${S.badge.log}>`));
	return { text: S.deploy.alertText(mention, badgeLine({ ...s, logUrl: undefined }, false)), blocks };
}

export async function getDeployRender(db: D1Database, runId: string): Promise<DeployRenderRow | null> {
	return db.prepare("SELECT * FROM deploy_renders WHERE run_id = ?1").bind(runId).first<DeployRenderRow>();
}

export async function upsertDeployRender(db: D1Database, row: DeployRenderRow): Promise<void> {
	await db
		.prepare(
			`INSERT INTO deploy_renders (run_id, repo, env, sha, slack_channel, slack_ts, check_run_id, state, step, step_index, steps_total, started_at, updated_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
			ON CONFLICT (run_id) DO UPDATE SET slack_channel = excluded.slack_channel, slack_ts = excluded.slack_ts, check_run_id = excluded.check_run_id,
				state = excluded.state, step = excluded.step, step_index = excluded.step_index, steps_total = excluded.steps_total, updated_at = excluded.updated_at`,
		)
		.bind(
			row.run_id,
			row.repo,
			row.env,
			row.sha,
			row.slack_channel,
			row.slack_ts,
			row.check_run_id,
			row.state,
			row.step,
			row.step_index,
			row.steps_total,
			row.started_at,
			row.updated_at,
		)
		.run();
}

const TERMINAL: Record<DeployState, boolean> = { queued: false, running: false, rolling_back: false, succeeded: true, failed: true };

function deployState(state: AgentEvent["state"]): DeployState {
	switch (state) {
		case "queued":
			return "queued";
		case "running":
		case "verifying":
			return "running";
		case "rolling_back":
			return "rolling_back";
		case "success":
			return "succeeded";
		default:
			return "failed";
	}
}

function now(env: Env): number {
	return (env.__TEST_CLOCK ?? systemClock).now();
}

/** The watched channel the deploy posts to: the one it already posted in, else the repo's first active watch. */
async function channelFor(env: Env, trigger: DeployTriggerRow, prior: string | null): Promise<{ teamId: string; channel: string } | null> {
	const t = tenantDb(env.DB, trigger.installation_id);
	const repo = await getRepoByFullName(t, trigger.repo);
	if (!repo) return null;
	const watches = (await listWatchesForRepo(t, repo.repo_id)).filter((w) => w.status === "active" || w.channel_id === prior);
	const watch = watches.find((w) => w.channel_id === prior) ?? watches[0];
	return watch ? { teamId: watch.team_id, channel: watch.channel_id } : null;
}

/** `<@U…>` for the commit author's linked Slack user, else their GitHub login, else ''. */
async function authorMention(env: Env, trigger: DeployTriggerRow, runId: string, teamId: string): Promise<string> {
	const run = await tenantDb(env.DB, trigger.installation_id).first<{ author_login: string | null }>(
		"SELECT author_login FROM runs WHERE installation_id = ?1 AND run_id = ?2",
		runId,
	);
	const login = run?.author_login;
	if (!login) return "";
	const link = await env.DB.prepare("SELECT slack_user_id FROM user_links WHERE team_id = ?1 AND github_login = ?2 COLLATE NOCASE LIMIT 1")
		.bind(teamId, login)
		.first<{ slack_user_id: string }>();
	return link ? `<@${link.slack_user_id}>` : login;
}

/** A signed link to the deploy's log, or undefined when the run has no job or signing fails. */
async function logUrlFor(env: Env, installationId: number, runId: string): Promise<string | undefined> {
	const job = await tenantDb(env.DB, installationId).first<{ name: string }>(
		"SELECT name FROM jobs WHERE run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1 AND run_id = ?2) ORDER BY name LIMIT 1",
		runId,
	);
	if (!job) return undefined;
	try {
		return await signLogUrl(env, runId, job.name);
	} catch (err) {
		reportError(err, { op: "deploy_log_url", run_id: runId });
		return undefined;
	}
}

async function syncCheckRun(env: Env, trigger: DeployTriggerRow, row: DeployRenderRow, badge: string): Promise<number> {
	const t = tenantDb(env.DB, trigger.installation_id);
	const repo = await getRepoByFullName(t, trigger.repo);
	if (!repo) throw new HubError("deploy_repo_unknown", 500, `deploy repo ${trigger.repo} is not known`);
	const gh = new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => now(env));
	const inst = await gh.installation(trigger.installation_id, { repositoryIds: [repo.repo_id], permissions: { checks: "write" } });
	const slash = repo.full_name.indexOf("/");
	const owner = repo.full_name.slice(0, slash);
	const name = repo.full_name.slice(slash + 1);
	const done = TERMINAL[row.state];
	const title = row.state === "succeeded" ? S.deploy.checkTitle.succeeded : row.state === "failed" ? S.deploy.checkTitle.failed : S.deploy.checkTitle.running;
	const body = {
		status: done ? ("completed" as const) : ("in_progress" as const),
		...(done ? { conclusion: row.state === "succeeded" ? ("success" as const) : ("failure" as const), completed_at: new Date(now(env)).toISOString() } : {}),
		output: { title, summary: badge },
	};
	if (row.check_run_id !== null) {
		await updateCheckRun(inst, owner, name, row.check_run_id, body);
		return row.check_run_id;
	}
	const created = await createCheckRun(inst, owner, name, {
		name: S.deploy.checkName(row.env),
		head_sha: row.sha,
		external_id: row.run_id,
		started_at: new Date(row.started_at).toISOString(),
		...body,
	});
	return created.id;
}

/**
 * Renders one agent event of a deploy run: the badge, the alert when the
 * deploy ends failed and the check run. Events for runs that are not deploys,
 * and events after the deploy ended, change nothing.
 */
export async function onDeployEvent(env: Env, ev: AgentEvent): Promise<void> {
	try {
		const trigger = await env.DB.prepare("SELECT * FROM deploy_triggers WHERE run_id = ?1").bind(ev.run_id).first<DeployTriggerRow>();
		if (!trigger) return;
		const prev = await getDeployRender(env.DB, ev.run_id);
		if (prev && TERMINAL[prev.state]) return;
		const at = now(env);
		const row: DeployRenderRow = {
			run_id: ev.run_id,
			repo: trigger.repo,
			env: trigger.env,
			sha: trigger.sha,
			slack_channel: prev?.slack_channel ?? null,
			slack_ts: prev?.slack_ts ?? null,
			check_run_id: prev?.check_run_id ?? null,
			// Job events only move the step; the run's own events move the state.
			state: ev.job === undefined ? deployState(ev.state) : (prev?.state ?? "running"),
			step: ev.step ?? prev?.step ?? null,
			step_index: ev.step_index ?? prev?.step_index ?? null,
			steps_total: ev.steps_total ?? prev?.steps_total ?? null,
			started_at: prev?.started_at ?? at,
			updated_at: at,
		};
		await upsertDeployRender(env.DB, row);

		const terminal = TERMINAL[row.state];
		const badge: DeployBadgeState = {
			env: row.env,
			sha: row.sha,
			state: row.state,
			runId: row.run_id,
			attempt: trigger.attempt,
			...(row.step !== null ? { step: row.step } : {}),
			...(row.step_index !== null ? { stepIndex: row.step_index } : {}),
			...(row.steps_total !== null ? { stepsTotal: row.steps_total } : {}),
			...(terminal ? { durationMs: ev.duration_ms ?? at - row.started_at } : {}),
			...(row.state === "failed" && prev?.state === "rolling_back" ? { rolledBack: true } : {}),
		};
		if (terminal) {
			const logUrl = await logUrlFor(env, trigger.installation_id, row.run_id);
			if (logUrl) badge.logUrl = logUrl;
		}

		try {
			const target = await channelFor(env, trigger, row.slack_channel);
			if (target) {
				const msg = renderDeployBadge(badge);
				const priority = terminal ? "terminal" : "normal";
				if (row.slack_ts === null || row.slack_channel === null) {
					const res = await slackApi(env, target.teamId, "chat.postMessage", { channel: target.channel, ...msg }, { priority });
					if (typeof res.ts === "string") {
						row.slack_channel = target.channel;
						row.slack_ts = res.ts;
						await upsertDeployRender(env.DB, row);
					}
				} else {
					await slackApiFireAndForget(
						env,
						target.teamId,
						"chat.update",
						{ channel: row.slack_channel, ts: row.slack_ts, ...msg },
						{ priority, coalesceKey: `deploy:${row.run_id}` },
					);
				}
				if (row.state === "failed") {
					const mention = await authorMention(env, trigger, row.run_id, target.teamId);
					const alert = renderDeployAlert(badge, ev.tail ?? [], mention);
					await slackApiFireAndForget(env, target.teamId, "chat.postMessage", { channel: target.channel, ...alert }, {
						priority: "alert",
						coalesceKey: `deploy-alert:${row.run_id}`,
					});
				}
			}
		} catch (err) {
			reportError(err, { op: "deploy_render_slack", run_id: row.run_id });
		}

		try {
			const id = await syncCheckRun(env, trigger, row, renderDeployBadge(badge).text);
			if (id !== row.check_run_id) {
				row.check_run_id = id;
				await upsertDeployRender(env.DB, row);
			}
		} catch (err) {
			reportError(err, { op: "deploy_render_check", run_id: row.run_id });
		}
	} catch (err) {
		reportError(err, { op: "deploy_render", run_id: ev.run_id });
	}
}

/** Posts the `not started: <reason>` badge for a deploy trigger the agent rejected. */
export async function renderRejected(env: Env, row: DeployTriggerRow): Promise<void> {
	try {
		const target = await channelFor(env, row, null);
		if (!target) return;
		const parts = [row.env, row.sha.slice(0, 7), S.deploy.notStarted(row.reason ?? "")].join(SEP);
		await slackApiFireAndForget(env, target.teamId, "chat.postMessage", {
			channel: target.channel,
			text: parts,
			blocks: [section(escapeMrkdwn(parts))],
		});
	} catch (err) {
		reportError(err, { op: "deploy_render_rejected", trigger_id: row.trigger_id });
	}
}
