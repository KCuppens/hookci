// How a deploy run shows up: a line in its push's Slack checks message (the
// sink folds it in, deploy/lines.ts), or with no such message one badge per
// run posted once and updated in place; a thread reply per step, one when it
// ends and a failure reply with the author's mention; and an informational
// `hookci/deploy:<env>` check run. Deploys never touch GitHub Deployments.
// The Slack part runs after the agent's event is answered, queued on the
// deploy's trigger, so Slack's pacing never holds the agent up. Every sink
// failure is reported and swallowed here, so the agent's event handler
// never sees it.

import { getRepoByFullName } from "../db/repos";
import { findMessagedChecksRun } from "../db/slack-messages";
import { type TenantDb, tenantDb } from "../db/tenant";
import { listWatchesForRepo, type WatchRow } from "../db/watches";
import { systemClock } from "../do/clock";
import { HubError } from "../errors";
import type { Env } from "../env";
import { createCheckRun, updateCheckRun } from "../github/api";
import { GitHubClient } from "../github/client";
import type { CheckRunConclusion } from "../github/types";
import { defaultFetcher } from "../http";
import { stableLogLink } from "../logs/links";
import { reportError } from "../observability";
import type { Event as AgentEvent } from "../protocol";
import type { SinkHost, WaitUntil } from "../sinks/index";
import { type SlackSink, slackSinkFactory } from "../sinks/slack";
import { slackApi, slackApiFireAndForget } from "../slack/api";
import { actions, type Block, button, section } from "../slack/blocks";
import { S } from "../strings";
import type { DeployTriggerRow } from "./chain";
import { badgeLine, type DeployBadgeState, DEPLOY_ACTIVE, type DeployState, RETRY_ACTION } from "./lines";

export interface DeployRenderRow {
	installation_id: number;
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
	/** 1 once the deploy failed after rolling back. */
	rolled_back: number;
	started_at: number;
	updated_at: number;
}

/** The deploy run's standalone Slack badge; a failed deploy gets a Retry button. */
export function renderDeployBadge(s: DeployBadgeState): { text: string; blocks: unknown[] } {
	const blocks: Block[] = [section(badgeLine(s, true))];
	if (s.state === "failed" && s.runId !== undefined && s.attempt !== undefined) {
		blocks.push(actions(button(RETRY_ACTION, S.deploy.retry, `${s.runId}:${s.attempt}`)));
	}
	return { text: badgeLine(s, false), blocks };
}

export async function getDeployRender(t: TenantDb, runId: string): Promise<DeployRenderRow | null> {
	return t.first<DeployRenderRow>("SELECT * FROM deploy_renders WHERE installation_id = ?1 AND run_id = ?2", runId);
}

/**
 * Stores the installation's render of a run; a run_id another installation
 * renders is left alone. A null Slack message keeps the stored one, which
 * the badge post sets after the event that rendered it.
 */
export async function upsertDeployRender(t: TenantDb, row: Omit<DeployRenderRow, "installation_id">): Promise<void> {
	await t.run(
		`INSERT INTO deploy_renders (installation_id, run_id, repo, env, sha, slack_channel, slack_ts, check_run_id, state, step, step_index, steps_total, rolled_back, started_at, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
		ON CONFLICT (run_id) DO UPDATE SET slack_channel = COALESCE(excluded.slack_channel, deploy_renders.slack_channel),
			slack_ts = COALESCE(excluded.slack_ts, deploy_renders.slack_ts), check_run_id = excluded.check_run_id,
			state = excluded.state, step = excluded.step, step_index = excluded.step_index, steps_total = excluded.steps_total,
			rolled_back = excluded.rolled_back, updated_at = excluded.updated_at
		WHERE deploy_renders.installation_id = excluded.installation_id`,
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
		row.rolled_back,
		row.started_at,
		row.updated_at,
	);
}

/**
 * Reopens the installation's finished render of runId as queued from now,
 * without its check run; a retry reuses the run id and gets a new check run.
 * Only a run of agentId in the installation is reopened.
 */
export async function reopenDeployRender(env: Env, installationId: number, runId: string, agentId: string): Promise<void> {
	const at = now(env);
	await tenantDb(env.DB, installationId).run(
		`UPDATE deploy_renders SET state = 'queued', step = NULL, step_index = NULL, steps_total = NULL, rolled_back = 0, check_run_id = NULL,
			started_at = ?3, updated_at = ?3
		WHERE installation_id = ?1 AND run_id = ?2 AND state IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'superseded')
			AND run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1 AND run_id = ?2 AND agent_id = ?4)`,
		runId,
		at,
		agentId,
	);
}

/** The check run conclusion of each state; null while the deploy is not finished. Only a failed deploy fails the check. */
const CONCLUSION: Record<DeployState, CheckRunConclusion | null> = {
	queued: null,
	running: null,
	rolling_back: null,
	succeeded: "success",
	failed: "failure",
	cancelled: "cancelled",
	interrupted: "cancelled",
	superseded: "neutral",
};

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
		case "failed":
			return "failed";
		case "cancelled":
		case "skipped":
			return "cancelled";
		case "interrupted":
			return "interrupted";
		case "superseded":
			return "superseded";
	}
}

function now(env: Env): number {
	return (env.__TEST_CLOCK ?? systemClock).now();
}

/** The watched channel the badge posts to: the one it already posted in, else the repo's first active watch. */
async function watchFor(t: TenantDb, repoId: number, prior: string | null): Promise<WatchRow | null> {
	const watches = (await listWatchesForRepo(t, repoId)).filter((w) => w.status === "active" || w.channel_id === prior);
	return watches.find((w) => w.channel_id === prior) ?? watches[0] ?? null;
}

/** The stable link to the deploy's first job's log, or undefined when the run has no job. */
async function logLinkFor(env: Env, installationId: number, runId: string): Promise<string | undefined> {
	const job = await tenantDb(env.DB, installationId).first<{ name: string }>(
		"SELECT name FROM jobs WHERE run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1 AND run_id = ?2) ORDER BY name LIMIT 1",
		runId,
	);
	return job ? stableLogLink(env, runId, job.name) : undefined;
}

async function syncCheckRun(env: Env, trigger: DeployTriggerRow, row: Omit<DeployRenderRow, "installation_id">, badge: string): Promise<number> {
	const t = tenantDb(env.DB, trigger.installation_id);
	const repo = await getRepoByFullName(t, trigger.repo);
	if (!repo) throw new HubError("deploy_repo_unknown", 500, `deploy repo ${trigger.repo} is not known`);
	const gh = new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => now(env));
	const inst = await gh.installation(trigger.installation_id, { repositoryIds: [repo.repo_id], permissions: { checks: "write" } });
	const slash = repo.full_name.indexOf("/");
	const owner = repo.full_name.slice(0, slash);
	const name = repo.full_name.slice(slash + 1);
	const conclusion = CONCLUSION[row.state];
	const title = S.deploy.checkTitle[row.state === "queued" || row.state === "rolling_back" ? "running" : row.state];
	const body = {
		status: conclusion ? ("completed" as const) : ("in_progress" as const),
		...(conclusion ? { conclusion, completed_at: new Date(now(env)).toISOString() } : {}),
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
 * Posts the deploy's standalone badge, or updates it in place, for a push
 * with no checks message to fold into; then the step, final or failure
 * reply in the badge's thread.
 */
async function postBadge(env: Env, t: TenantDb, sink: SlackSink, repoId: number, runId: string, badge: DeployBadgeState, tail: string[]): Promise<void> {
	const render = await getDeployRender(t, runId);
	if (!render) return;
	const watch = await watchFor(t, repoId, render.slack_channel);
	if (!watch) return;
	const msg = renderDeployBadge(badge);
	const priority = DEPLOY_ACTIVE[badge.state] ? "normal" : "terminal";
	let ts = render.slack_ts;
	if (ts === null || render.slack_channel === null) {
		const res = await slackApi(env, watch.team_id, "chat.postMessage", { channel: watch.channel_id, ...msg }, { priority });
		if (typeof res.ts !== "string") return;
		ts = res.ts;
		await t.run("UPDATE deploy_renders SET slack_channel = ?3, slack_ts = ?4 WHERE installation_id = ?1 AND run_id = ?2", runId, watch.channel_id, ts);
	} else {
		await slackApiFireAndForget(
			env,
			watch.team_id,
			"chat.update",
			{ channel: render.slack_channel, ts, ...msg },
			{ priority, coalesceKey: `${render.slack_channel}:${ts}` },
		);
	}
	const run =
		badge.state === "failed" || badge.state === "succeeded"
			? await t.first<{ author_login: string | null }>("SELECT author_login FROM runs WHERE installation_id = ?1 AND run_id = ?2", runId)
			: null;
	await sink.deployReply(render.repo, runId, watch, ts, badge, tail, run?.author_login ?? null);
}

/**
 * Renders one agent event of a deploy run of installationId: its line in the
 * push's checks message or its own badge, its thread reply, and the check
 * run. Events for runs that are not the installation's deploys, and events
 * after the deploy ended, change nothing. The Slack part goes to ctx.
 */
export async function onDeployEvent(env: Env, installationId: number, ev: AgentEvent, ctx: WaitUntil, host: SinkHost): Promise<void> {
	try {
		const t = tenantDb(env.DB, installationId);
		const trigger = await t.first<DeployTriggerRow>(
			"SELECT * FROM deploy_triggers WHERE installation_id = ?1 AND run_id = ?2 ORDER BY attempt DESC LIMIT 1",
			ev.run_id,
		);
		if (!trigger) return;
		const prev = await getDeployRender(t, ev.run_id);
		if (prev && CONCLUSION[prev.state] !== null) return;
		const at = now(env);
		// Job events only move the step; the run's own events move the state.
		const state = ev.job === undefined ? deployState(ev.state) : (prev?.state ?? "running");
		const row: Omit<DeployRenderRow, "installation_id"> = {
			run_id: ev.run_id,
			repo: trigger.repo,
			env: trigger.env,
			sha: trigger.sha,
			slack_channel: prev?.slack_channel ?? null,
			slack_ts: prev?.slack_ts ?? null,
			check_run_id: prev?.check_run_id ?? null,
			state,
			step: ev.step ?? prev?.step ?? null,
			step_index: ev.step_index ?? prev?.step_index ?? null,
			steps_total: ev.steps_total ?? prev?.steps_total ?? null,
			rolled_back: state === "failed" && prev?.state === "rolling_back" ? 1 : (prev?.rolled_back ?? 0),
			started_at: prev?.started_at ?? at,
			updated_at: at,
		};
		await upsertDeployRender(t, row);

		const terminal = CONCLUSION[row.state] !== null;
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
			...(row.rolled_back === 1 ? { rolledBack: true } : {}),
		};
		if (terminal) {
			const logUrl = await logLinkFor(env, trigger.installation_id, row.run_id);
			if (logUrl) badge.logUrl = logUrl;
		}

		const tail = ev.tail ?? [];
		const sink = slackSinkFactory(env, installationId, host);
		// After the deploy run's own sink calls on its trigger: one render at a time, in event order.
		// A fold waits for the checks message's own renders in the AgentDO that owns that run.
		const render = sink.inOrder(trigger.trigger_id, async () => {
			if (await sink.foldDeploy(trigger.trigger_id, { badge, tail })) return;
			const repo = await getRepoByFullName(t, trigger.repo);
			if (repo) await postBadge(env, t, sink, repo.repo_id, row.run_id, badge, tail);
		});
		ctx.waitUntil(render.catch((err: unknown) => reportError(err, { op: "deploy_render_slack", run_id: row.run_id })));

		try {
			const id = await syncCheckRun(env, trigger, row, renderDeployBadge(badge).text);
			if (id !== row.check_run_id) {
				row.check_run_id = id;
				await upsertDeployRender(t, row);
			}
		} catch (err) {
			reportError(err, { op: "deploy_render_check", run_id: row.run_id });
		}
	} catch (err) {
		reportError(err, { op: "deploy_render", run_id: ev.run_id });
	}
}

/**
 * Posts the `not started: <reason>` badge for a deploy trigger the agent
 * rejected, when the checks run that chained it has no message: the sink
 * folds it into that message when the rejected run fans out.
 */
export async function renderRejected(env: Env, row: DeployTriggerRow): Promise<void> {
	try {
		const t = tenantDb(env.DB, row.installation_id);
		if (await findMessagedChecksRun(t, row.trigger_id)) return;
		const repo = await getRepoByFullName(t, row.repo);
		if (!repo) return;
		const watch = await watchFor(t, repo.repo_id, null);
		if (!watch) return;
		const msg = renderDeployBadge({ env: row.env, sha: row.sha, state: "rejected", reason: row.reason ?? "" });
		await slackApiFireAndForget(env, watch.team_id, "chat.postMessage", { channel: watch.channel_id, ...msg });
	} catch (err) {
		reportError(err, { op: "deploy_render_rejected", trigger_id: row.trigger_id });
	}
}
