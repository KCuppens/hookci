// The Slack Web API client for one workspace's bot. Every call goes through
// the workspace's SlackWorkspaceDO queue, which owns the bot token and keeps
// the workspace inside Slack's rate limits (do/slack-outbound.ts).

import { systemClock } from "../do/clock";
import type { SlackCall, SlackCallResult, SlackPriority } from "../do/slack-queue";
import type { Env } from "../env";
import { HubError } from "../errors";
import { ulid } from "../ulid";

export type SlackApiResult = { ok: true } & Record<string, unknown>;

export interface SlackFireAndForgetOptions {
	priority?: SlackPriority;
	/** `${channel}:${ts}` for chat.update: a later call with the same key replaces a queued one. */
	coalesceKey?: string;
	/** The channel posted to; defaults to body.channel. */
	channel?: string;
}

export interface SlackApiOptions {
	priority?: SlackPriority;
	/** The sink's claim on this post; see SlackCall.claim. A call that carries one answers queue_deferred instead of queue_timeout. */
	claim?: string;
}

async function callQueue(
	env: Env,
	teamId: string,
	method: string,
	body: Record<string, unknown>,
	opts: SlackFireAndForgetOptions & SlackApiOptions,
	wait: boolean,
): Promise<SlackCallResult> {
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const call: SlackCall = { id: ulid(now), method, body, priority: opts.priority ?? "normal", enqueuedAt: now, attempts: 0 };
	if (opts.coalesceKey !== undefined) call.coalesceKey = opts.coalesceKey;
	if (opts.claim !== undefined) call.claim = opts.claim;
	const channel = opts.channel ?? body.channel;
	if (typeof channel === "string") call.channel = channel;
	const stub = env.SLACK_DO.get(env.SLACK_DO.idFromName(teamId));
	const res = await stub.fetch("https://do/call", { method: "POST", body: JSON.stringify({ teamId, call, wait }) });
	if (!res.ok) throw new HubError("slack_do_failed", 502, `SlackWorkspaceDO /call answered ${res.status}`);
	return res.json<SlackCallResult>();
}

/**
 * Calls `https://slack.com/api/<method>` as team teamId's bot and waits for
 * the answer (at most 10 s in the queue). Throws slack_api (502) with Slack's
 * error code as message when the call fails, such as channel_not_found,
 * workspace_inactive or queue_timeout, or queue_deferred when a call with a
 * claim is still queued at 10 s: it stays queued and completeQueuedSlackPost
 * gets its result.
 */
export async function slackApi(
	env: Env,
	teamId: string,
	method: string,
	args: Record<string, unknown>,
	opts: SlackApiOptions = {},
): Promise<SlackApiResult> {
	const res = await callQueue(env, teamId, method, args, opts, true);
	if (!res.ok) throw new HubError("slack_api", 502, res.error ?? "unknown_error");
	return res.data as SlackApiResult;
}

/** Queues the call and returns once the queue holds it; failures are logged by the queue. */
export async function slackApiFireAndForget(
	env: Env,
	teamId: string,
	method: string,
	body: Record<string, unknown>,
	opts: SlackFireAndForgetOptions = {},
): Promise<void> {
	await callQueue(env, teamId, method, body, opts, false);
}
