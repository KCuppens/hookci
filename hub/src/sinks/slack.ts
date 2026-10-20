// The Slack sink: in every channel watching the repo, or the channel the
// repo's .zeroci.yml notify.slack names in the watch's workspace, one message
// per run posted once and then updated in place, a thread reply per finished
// job (normal notify only), one alert when the run fails, and a DM to the
// agent's admin when it goes offline. It never reads channel history: what
// it posted is in slack_messages and slack_job_replies. A first post or reply
// still queued after the queue's 10 s wait stays queued under its claim, and
// the workspace queue hands its result to completeQueuedSlackPost.

import { tenantDb, type TenantDb } from "../db/tenant";
import {
	adoptSlackMessages,
	claimAlert,
	claimSlackMessage,
	claimThreadReply,
	getSlackMessage,
	putSlackMessage,
	releaseSlackMessage,
	releaseThreadReply,
	setAlertTs,
	setThreadReply,
} from "../db/slack-messages";
import { listWatchesForRepo, type WatchRow } from "../db/watches";
import { claimOfflineDm, clearOfflineDm } from "../do/agent-hooks";
import { systemClock } from "../do/clock";
import type { SlackCallResult } from "../do/slack-queue";
import type { Env } from "../env";
import { HubError } from "../errors";
import { signLogUrl } from "../logs/signing";
import { getLogTail } from "../logs/tail";
import { logEvent, reportError } from "../observability";
import { slackApi, slackApiFireAndForget } from "../slack/api";
import { resolveAuthor } from "../slack/authors";
import { TERMINAL } from "../slack/badge";
import { findChannel } from "../slack/channels";
import { renderAlert, renderJobReply, renderOfflineDm, renderRunMessage, TAIL_LINES } from "../slack/messages";
import { registerSinkFactory, type SinkHost } from "./index";
import { loadRunView } from "./runview";
import type { AgentView, JobView, RunView, Sink } from "./types";

/** How often, and how far apart, a call that lost the first post re-reads the winner's ts. */
const FIRST_POST_REREADS = 3;
const FIRST_POST_REREAD_MS = 200;

/**
 * Slack errors that end the call without a bug on our side: the channel is
 * gone (the outbound queue breaks its watches) or the workspace is.
 */
const EXPECTED_ERRORS: Record<string, true> = {
	channel_not_found: true,
	not_in_channel: true,
	is_archived: true,
	workspace_inactive: true,
	workspace_not_found: true,
	token_revoked: true,
	account_inactive: true,
	invalid_auth: true,
};

/**
 * What the agent sent with the failed job's final state, kept in the AgentDO
 * until the run ends: its tail, the alert's fallback when no log was
 * uploaded, or that the repo keeps its logs on the agent.
 */
interface StoredTail {
	job: string;
	tail: string[];
	logs?: "local";
	/** When it was stored; a tail left this long by a run that never ended is pruned. */
	at: number;
}

/** The failed job the alert names and what it shows of the log. */
interface AlertLog {
	job: JobView;
	tail: string[];
	logUrl: string | null;
}

/**
 * The claim on a run message or thread reply the sink is posting, carried by
 * the queued call (SlackCall.claim) so completeQueuedSlackPost can finish it
 * once the sink stopped waiting.
 */
type QueuedPostClaim = { installationId: number; teamId: string; channelId: string; runKey: string } & (
	| { kind: "message"; triggerId: string }
	| { kind: "reply"; job: string }
);

/** Per AgentDO storage, the tail of the work on each run: calls on one run go one after another. */
const runQueues = new WeakMap<DurableObjectStorage, Map<string, Promise<void>>>();

export class SlackSink implements Sink {
	readonly name = "slack";
	private readonly t: TenantDb;

	constructor(
		private readonly env: Env,
		installationId: number,
		private readonly now: () => number,
		private readonly host?: SinkHost,
	) {
		this.t = tenantDb(env.DB, installationId);
	}

	async onRunUpdate(run: RunView): Promise<void> {
		await this.inOrder(run.triggerId, () => this.update(run));
	}

	async onJobPlanned(run: RunView): Promise<void> {
		await this.inOrder(run.triggerId, () => this.update(run));
	}

	async onJobUpdate(run: RunView, job: JobView): Promise<void> {
		await this.inOrder(run.triggerId, () => this.update(run, [job]));
	}

	/**
	 * Brings the run's message in one channel up to date after its first post
	 * waited in the queue: the run's state now, a reply for each job that
	 * finished meanwhile, and the alert when the run failed.
	 */
	async catchUp(run: RunView, teamId: string, channelId: string): Promise<void> {
		await this.inOrder(run.triggerId, () =>
			this.update(
				run,
				run.jobs.filter((job) => TERMINAL.has(job.state)),
				`${teamId}:${channelId}`,
			),
		);
	}

	/** Annotations belong to the GitHub checks; Slack shows the job's result and log tail instead. */
	async onAnnotations(): Promise<void> {}

	async onAgentOffline(agent: AgentView, affected: RunView[]): Promise<void> {
		for (const run of affected) {
			await this.inOrder(run.triggerId, () => this.update({ ...run, state: "pending", reason: "agent_offline" }));
		}
		if (!this.host) return;
		const admins = await this.t.all<{ team_id: string; slack_user_id: string }>(
			`SELECT ul.team_id, ul.slack_user_id FROM agents a
			JOIN user_links ul ON ul.github_user_id = a.paired_by_github_id
			JOIN workspace_links wl ON wl.team_id = ul.team_id AND wl.installation_id = a.installation_id
			WHERE a.installation_id = ?1 AND a.agent_id = ?2`,
			agent.agentId,
		);
		if (admins.length === 0 || !claimOfflineDm(this.host.storage, this.now())) return;
		const msg = renderOfflineDm(agent, affected);
		let sent = 0;
		for (const admin of admins) {
			try {
				await slackApi(this.env, admin.team_id, "chat.postMessage", { channel: admin.slack_user_id, text: msg.text, blocks: msg.blocks }, { priority: "alert" });
				sent++;
			} catch (err) {
				this.failed(err, { team_id: admin.team_id, agent_id: agent.agentId, op: "offline_dm" });
			}
		}
		if (sent === 0) clearOfflineDm(this.host.storage);
	}

	/** Posts or updates the run's message in each target channel, or in the one channel `${team}:${channel}` only names, and replies for jobs that finished. */
	private async update(run: RunView, jobs: JobView[] = [], only?: string): Promise<void> {
		// Deploy runs have their own badge, alert and check run (deploy/render.ts).
		if (run.target !== "checks") return;
		const watches = (await listWatchesForRepo(this.t, run.repoId)).filter((w) => w.status === "active");
		if (watches.length === 0) return;
		if (run.runId) await adoptSlackMessages(this.t, run.triggerId, run.runId);
		const runKey = run.runId ?? run.triggerId;
		for (const job of jobs) {
			if (job.state !== "failed" || !((job.tail && job.tail.length > 0) || job.logs === "local") || !this.host) continue;
			const key = tailKey(runKey);
			if ((await this.host.storage.get(key)) === undefined) {
				await this.host.storage.put(key, {
					job: job.name,
					tail: job.tail ?? [],
					...(job.logs ? { logs: job.logs } : {}),
					at: this.host.now(),
				} satisfies StoredTail);
			}
		}
		let failure: Promise<AlertLog | null> | undefined;
		const alertLog = () => (failure ??= this.alertLog(run, runKey));

		for (const { watch, followOnly } of await this.targets(run, runKey, watches)) {
			if (only !== undefined && `${watch.team_id}:${watch.channel_id}` !== only) continue;
			try {
				const ts = await this.postOrUpdate(run, runKey, watch, followOnly);
				if (ts === null || followOnly) continue;
				if (watch.notify === "normal") for (const job of jobs) if (TERMINAL.has(job.state)) await this.reply(run, runKey, watch, ts, job);
				if (run.state === "failed") await this.alert(run, runKey, watch, ts, alertLog);
			} catch (err) {
				this.failed(err, { team_id: watch.team_id, channel_id: watch.channel_id, run_id: runKey });
			}
		}

		if (run.authorEmail) await this.learnAuthor(run, watches);
		if (TERMINAL.has(run.state) && this.host) await this.host.storage.delete(tailKey(runKey));
	}

	/**
	 * Where the run's message goes: each watch's channel, or with a
	 * .zeroci.yml override the named channel in the watch's workspace, with
	 * the override's notify and alert over the watch's. A name the bot cannot
	 * post to leaves the watch as it is. A watch channel that got the run's
	 * message before the agent read the override keeps it updated
	 * (followOnly) without replies or alert.
	 */
	private async targets(run: RunView, runKey: string, watches: WatchRow[]): Promise<{ watch: WatchRow; followOnly: boolean }[]> {
		const { slack } = run;
		if (!slack) return watches.map((watch) => ({ watch, followOnly: false }));
		const targets = new Map<string, { watch: WatchRow; followOnly: boolean }>();
		const moved: WatchRow[] = [];
		for (const watch of watches) {
			let id = watch.channel_id;
			try {
				const found = await findChannel(this.env, watch.team_id, slack.channel, this.now());
				if (found.kind === "found") {
					id = found.id;
				} else if (found.firstReport) {
					logEvent("slack_override_unresolved", { team_id: watch.team_id, channel: slack.channel, reason: found.reason, run_id: runKey });
				}
			} catch (err) {
				this.failed(err, { team_id: watch.team_id, channel: slack.channel, run_id: runKey, op: "find_channel" });
			}
			if (id === watch.channel_id) {
				targets.set(`${watch.team_id}:${id}`, { watch, followOnly: false });
				continue;
			}
			moved.push(watch);
			if (!targets.has(`${watch.team_id}:${id}`)) {
				const overridden = { ...watch, channel_id: id, notify: slack.notify ?? watch.notify, alert: slack.alert ?? watch.alert };
				targets.set(`${watch.team_id}:${id}`, { watch: overridden, followOnly: false });
			}
		}
		for (const watch of moved) {
			if (!targets.has(`${watch.team_id}:${watch.channel_id}`)) targets.set(`${watch.team_id}:${watch.channel_id}`, { watch, followOnly: true });
		}
		return [...targets.values()];
	}

	/**
	 * Posts the run's message in the watch's channel, or updates it once
	 * posted; returns its ts, or null when a first post has not answered yet
	 * (another call's, or this one's left in the queue past 10 s, whose ts
	 * completeQueuedSlackPost stores) or followOnly finds no message to update.
	 */
	private async postOrUpdate(run: RunView, runKey: string, watch: WatchRow, followOnly: boolean): Promise<string | null> {
		const { team_id: team, channel_id: channel } = watch;
		const msg = renderRunMessage(run, { notify: watch.notify });
		const priority = TERMINAL.has(run.state) ? "terminal" : "normal";
		let row = await getSlackMessage(this.t, runKey, team, channel);
		if (!row && followOnly) return null;
		if (!row && (await claimSlackMessage(this.t, runKey, team, channel))) {
			const claim: QueuedPostClaim = { kind: "message", installationId: this.t.installationId, teamId: team, channelId: channel, runKey, triggerId: run.triggerId };
			try {
				const res = await slackApi(this.env, team, "chat.postMessage", { channel, text: msg.text, blocks: msg.blocks }, { priority, claim: JSON.stringify(claim) });
				const ts = String(res.ts);
				await putSlackMessage(this.t, { run_id: runKey, team_id: team, channel_id: channel, ts });
				return ts;
			} catch (err) {
				if (err instanceof HubError && err.code === "slack_api" && err.message === "queue_deferred") {
					logEvent("slack_post_deferred", { run_id: runKey, team_id: team, channel_id: channel });
					return null;
				}
				await releaseSlackMessage(this.t, runKey, team, channel);
				throw err;
			}
		}
		for (let i = 0; (row?.ts ?? "") === "" && i < FIRST_POST_REREADS; i++) {
			await new Promise<void>((resolve) => setTimeout(resolve, FIRST_POST_REREAD_MS));
			row = await getSlackMessage(this.t, runKey, team, channel);
		}
		if (!row?.ts) {
			logEvent("slack_message_not_posted", { run_id: runKey, team_id: team, channel_id: channel });
			return null;
		}
		await slackApiFireAndForget(
			this.env,
			team,
			"chat.update",
			{ channel, ts: row.ts, text: msg.text, blocks: msg.blocks },
			{ coalesceKey: `${channel}:${row.ts}`, priority },
		);
		return row.ts;
	}

	private async reply(run: RunView, runKey: string, watch: WatchRow, parentTs: string, job: JobView): Promise<void> {
		const { team_id: team, channel_id: channel } = watch;
		if (!(await claimThreadReply(this.t, runKey, team, channel, job.name))) return;
		const msg = renderJobReply(run, job);
		const claim: QueuedPostClaim = { kind: "reply", installationId: this.t.installationId, teamId: team, channelId: channel, runKey, job: job.name };
		try {
			const res = await slackApi(
				this.env,
				team,
				"chat.postMessage",
				{ channel, thread_ts: parentTs, text: msg.text, blocks: msg.blocks },
				{ claim: JSON.stringify(claim) },
			);
			await setThreadReply(this.t, runKey, team, channel, job.name, String(res.ts));
		} catch (err) {
			if (err instanceof HubError && err.code === "slack_api" && err.message === "queue_deferred") {
				logEvent("slack_post_deferred", { run_id: runKey, team_id: team, channel_id: channel, job: job.name });
				return;
			}
			await releaseThreadReply(this.t, runKey, team, channel, job.name);
			throw err;
		}
	}

	/** Posts the run's one failure alert for the watch: a DM to the author when asked and known, else in the thread. */
	private async alert(run: RunView, runKey: string, watch: WatchRow, parentTs: string, alertLog: () => Promise<AlertLog | null>): Promise<void> {
		const { team_id: team, channel_id: channel } = watch;
		if (!(await claimAlert(this.t, runKey, team, channel))) return;
		try {
			const log = await alertLog();
			if (!log) {
				await setAlertTs(this.t, runKey, team, channel, null);
				return;
			}
			const { job, tail, logUrl } = log;
			const author = await resolveAuthor(this.env, this.t.installationId, team, { login: run.authorLogin, email: run.authorEmail });
			let target = { channel, thread_ts: parentTs };
			const msg = renderAlert(run, job, tail, watch.alert === "dm" ? null : author, logUrl);
			if (watch.alert === "dm" && author) {
				const { channel: dm } = await slackApi(this.env, team, "conversations.open", { users: author }, { priority: "alert" });
				if (typeof dm !== "object" || dm === null || !("id" in dm) || typeof dm.id !== "string") {
					throw new HubError("slack_api", 502, "conversations_open_no_channel");
				}
				target = { channel: dm.id, thread_ts: "" };
			}
			const res = await slackApi(
				this.env,
				team,
				"chat.postMessage",
				{ channel: target.channel, ...(target.thread_ts ? { thread_ts: target.thread_ts } : {}), text: msg.text, blocks: msg.blocks },
				{ priority: "alert" },
			);
			await setAlertTs(this.t, runKey, team, channel, String(res.ts));
		} catch (err) {
			await setAlertTs(this.t, runKey, team, channel, null);
			throw err;
		}
	}

	/**
	 * The failed job and its log for the alert, read once per update: the
	 * last TAIL_LINES lines of the uploaded log with a signed link to it, else
	 * the tail the agent sent (kept in the AgentDO), else nothing.
	 */
	private async alertLog(run: RunView, runKey: string): Promise<AlertLog | null> {
		const stored = (await this.host?.storage.get<StoredTail>(tailKey(runKey))) ?? { job: "", tail: [], at: 0 };
		const found = run.jobs.find((j) => j.name === stored.job) ?? run.jobs.find((j) => j.state === "failed");
		if (!found) return null;
		const own = stored.job === found.name;
		const job: JobView = own && stored.logs ? { ...found, logs: stored.logs } : found;
		const fallback = { job, tail: own ? stored.tail : [], logUrl: null };
		if (job.logs === "local" || !run.runId) return fallback;
		const tail = await getLogTail(this.env, run.runId, job.name, TAIL_LINES);
		if (!tail) return fallback;
		const ref = { installationId: this.t.installationId, runId: run.runId, job: job.name };
		return { job, tail, logUrl: await signLogUrl(this.env, ref, new Date(this.now())) };
	}

	/**
	 * Only the trigger's own update carries the commit email; resolving the
	 * author then caches the answer by login for the alert that comes later.
	 */
	private async learnAuthor(run: RunView, watches: WatchRow[]): Promise<void> {
		for (const team of new Set(watches.map((w) => w.team_id))) {
			try {
				await resolveAuthor(this.env, this.t.installationId, team, { login: run.authorLogin, email: run.authorEmail });
			} catch (err) {
				this.failed(err, { team_id: team, op: "resolve_author" });
			}
		}
	}

	private failed(err: unknown, ctx: Record<string, string>): void {
		if (err instanceof HubError && err.code === "slack_api" && Object.hasOwn(EXPECTED_ERRORS, err.message)) {
			logEvent("slack_sink_skipped", { ...ctx, error: err.message });
		} else {
			reportError(err, { sink: "slack", ...ctx });
		}
	}

	private async inOrder(triggerId: string, fn: () => Promise<void>): Promise<void> {
		if (!this.host) return fn();
		let queues = runQueues.get(this.host.storage);
		if (!queues) runQueues.set(this.host.storage, (queues = new Map()));
		const call = (queues.get(triggerId) ?? Promise.resolve()).then(fn);
		const tail = call.catch(() => {});
		queues.set(triggerId, tail);
		await tail.then(() => {
			if (queues.get(triggerId) === tail) queues.delete(triggerId);
		});
		return call;
	}
}

function tailKey(runKey: string): string {
	return `${TAIL_PREFIX}${runKey}`;
}

/**
 * Finishes a post that stayed in the SlackWorkspaceDO queue after its sink
 * stopped waiting (queue_deferred): stores the ts Slack gave it, or drops the
 * claim when it failed, as the sink would have. A run message then catches
 * up with what the run did while its first post was queued.
 */
export async function completeQueuedSlackPost(env: Env, claim: string, result: SlackCallResult): Promise<void> {
	const ref = JSON.parse(claim) as QueuedPostClaim;
	const t = tenantDb(env.DB, ref.installationId);
	const data = result.ok ? result.data : undefined;
	const ts = typeof data === "object" && data !== null && "ts" in data && typeof data.ts === "string" ? data.ts : null;
	if (ref.kind === "reply") {
		if (ts === null) await releaseThreadReply(t, ref.runKey, ref.teamId, ref.channelId, ref.job);
		else await setThreadReply(t, ref.runKey, ref.teamId, ref.channelId, ref.job, ts);
		return;
	}
	const run = await loadRunView(env.DB, ref.installationId, ref.runKey === ref.triggerId ? { triggerId: ref.triggerId } : { runId: ref.runKey });
	// The agent may have accepted the run under its own id while the post was queued.
	const runKey = run?.runId ?? ref.runKey;
	if (runKey !== ref.runKey) await adoptSlackMessages(t, ref.triggerId, runKey);
	if (ts === null) {
		await releaseSlackMessage(t, runKey, ref.teamId, ref.channelId);
		return;
	}
	await putSlackMessage(t, { run_id: runKey, team_id: ref.teamId, channel_id: ref.channelId, ts });
	if (run) await slackSinkFactory(env, ref.installationId).catchUp(run, ref.teamId, ref.channelId);
}

const TAIL_PREFIX = "slack:tail:";

/** Deletes the stored tails of runs that never ended, stored before `before`. */
export async function pruneStoredTails(storage: DurableObjectStorage, before: number): Promise<number> {
	const stale = [...(await storage.list<Partial<StoredTail>>({ prefix: TAIL_PREFIX }))].filter(([, v]) => (v.at ?? 0) < before).map(([k]) => k);
	for (let i = 0; i < stale.length; i += 128) await storage.delete(stale.slice(i, i + 128));
	return stale.length;
}

export function slackSinkFactory(env: Env, installationId: number, host?: SinkHost): SlackSink {
	const now = host ? () => host.now() : () => (env.__TEST_CLOCK ?? systemClock).now();
	return new SlackSink(env, installationId, now, host);
}

registerSinkFactory("slack", slackSinkFactory);
