// The Slack sink: in every channel watching the repo, or the channel the
// repo's .hookci.yml notify.slack names in the watch's workspace, one message
// per run posted once and then updated in place, a thread reply per finished
// job (normal notify only), one failure reply in the thread (or a DM to the
// author) when the run fails, and a DM to the agent's admin when it goes
// offline. A passed push's deploys fold into its message: a line per env,
// a reply per deploy step and one when the deploy ends, and the same
// failure reply. It never reads channel history: what it posted is in
// slack_messages and slack_job_replies. A first post or reply still queued
// after the queue's 10 s wait stays queued under its claim, and the
// workspace queue hands its result to completeQueuedSlackPost.

import { tenantDb, type TenantDb } from "../db/tenant";
import {
	adoptSlackMessages,
	claimAlert,
	claimSlackMessage,
	claimThreadReply,
	findMessagedChecksRun,
	getSlackMessage,
	putSlackMessage,
	releaseSlackMessage,
	releaseThreadReply,
	setAlertTs,
	setThreadReply,
} from "../db/slack-messages";
import { type DeployBadgeState, loadDeployLines } from "../deploy/lines";
import { listWatchesForRepo, type WatchRow } from "../db/watches";
import { claimOfflineDm, clearOfflineDm } from "../do/agent-hooks";
import { systemClock } from "../do/clock";
import type { SlackCallResult } from "../do/slack-queue";
import type { Env } from "../env";
import { HubError } from "../errors";
import { stableLogLink } from "../logs/links";
import { getLogTail } from "../logs/tail";
import { logEvent, reportError } from "../observability";
import { slackApi, slackApiFireAndForget } from "../slack/api";
import { resolveAuthor } from "../slack/authors";
import { TERMINAL } from "../slack/badge";
import { findChannel } from "../slack/channels";
import {
	renderAlert,
	renderDeployFailure,
	renderDeployReply,
	renderJobReply,
	renderOfflineDm,
	renderRunMessage,
	type SlackMessage,
	TAIL_LINES,
} from "../slack/messages";
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
	logLink: string | null;
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

/**
 * A deploy event to reply to in the thread: the deploy as that event left
 * it, since later events may have moved its render on by the time the
 * reply goes out, and the log tail the agent sent with it.
 */
export interface DeployReplyEvent {
	badge: DeployBadgeState;
	tail: string[];
}

/**
 * The body of an AgentDO's POST /slack-fold: render the checks run's message
 * with its deploys in the queue of the AgentDO that owns the run, and with
 * deploy, that deploy's reply.
 */
export interface SlackFoldRequest {
	installationId: number;
	checksRunId: string;
	checksTriggerId: string;
	deploy?: DeployReplyEvent;
}

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
		await this.inOrder(run.triggerId, () => this.update(run, { jobs: [job] }));
	}

	/**
	 * Brings the run's message in one channel up to date after its first post
	 * waited in the queue: the run's state now, a reply for each job that
	 * finished meanwhile, and the alert when the run failed.
	 */
	async catchUp(run: RunView, teamId: string, channelId: string): Promise<void> {
		await this.inOrder(run.triggerId, () => this.update(run, { jobs: run.jobs.filter((job) => TERMINAL.has(job.state)), only: `${teamId}:${channelId}` }));
	}

	/**
	 * Renders the deploys of the checks run that chained deployTriggerId into
	 * its message, and with deploy, posts that deploy's step, final or failure
	 * reply in the thread. Only a passed checks run shows them: one still
	 * running folds them in when it ends. The render runs in the AgentDO that
	 * owns the checks run, so it waits behind that run's own renders. False
	 * when the checks run has no message, so the deploy keeps its own badge.
	 */
	async foldDeploy(deployTriggerId: string, deploy?: DeployReplyEvent): Promise<boolean> {
		const found = await findMessagedChecksRun(this.t, deployTriggerId);
		if (!found) return false;
		if (found.agent_id === null || found.agent_id === this.host?.agentId) {
			await this.foldInto(found.run_id, found.trigger_id, deploy);
			return true;
		}
		const body: SlackFoldRequest = {
			installationId: this.t.installationId,
			checksRunId: found.run_id,
			checksTriggerId: found.trigger_id,
			...(deploy ? { deploy } : {}),
		};
		const res = await this.env.AGENT_DO.get(this.env.AGENT_DO.idFromName(found.agent_id)).fetch("https://do/slack-fold", {
			method: "POST",
			headers: { "x-hookci-agent-id": found.agent_id },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new HubError("agent_do_failed", 502, `slack fold for ${found.agent_id} answered ${res.status}`);
		return true;
	}

	/** Renders the checks run's message with its deploys, and deploy's reply, once its queued renders in this AgentDO are done. */
	async foldInto(checksRunId: string, checksTriggerId: string, deploy?: DeployReplyEvent): Promise<void> {
		await this.inOrder(checksTriggerId, async () => {
			const run = await loadRunView(this.env, this.t.installationId, { runId: checksRunId });
			if (run?.state === "success") await this.update(run, deploy ? { deploy } : {});
		});
	}

	/**
	 * Posts a deploy's reply in the thread of parentTs once per step and once
	 * when it ends, claimed in slack_job_replies under runKey: steps and the
	 * final line for normal notify only, a failure always. A success and a
	 * failure mention the author; a failure goes to them as a DM instead when
	 * the watch alerts by DM.
	 */
	async deployReply(
		repo: string,
		runKey: string,
		watch: WatchRow,
		parentTs: string,
		s: DeployBadgeState,
		tail: string[],
		authorLogin: string | null,
	): Promise<void> {
		const key = deployReplyKey(s);
		if (key === null || (s.state !== "failed" && watch.notify !== "normal")) return;
		const { team_id: team, channel_id: channel } = watch;
		if (!(await claimThreadReply(this.t, runKey, team, channel, key))) return;
		if (s.state !== "failed") {
			let mention: string | null = null;
			try {
				if (s.state === "succeeded" && authorLogin) mention = await this.deployAuthor(team, authorLogin);
			} catch (err) {
				await releaseThreadReply(this.t, runKey, team, channel, key);
				throw err;
			}
			const msg = renderDeployReply(s, mention);
			await this.postReply(runKey, watch, key, { channel, thread_ts: parentTs, text: msg.text, blocks: msg.blocks });
			return;
		}
		let target: { channel: string; thread_ts?: string } = { channel, thread_ts: parentTs };
		let msg: SlackMessage;
		try {
			const author = authorLogin ? await this.deployAuthor(team, authorLogin) : null;
			if (watch.alert === "dm" && author) target = { channel: await this.openDm(team, author) };
			const log = tail.length > 0 || !s.runId || !s.logJob ? tail : ((await getLogTail(this.env, s.runId, s.logJob, TAIL_LINES)) ?? []);
			msg = renderDeployFailure(repo, s, log, watch.alert === "dm" ? null : author);
		} catch (err) {
			await releaseThreadReply(this.t, runKey, team, channel, key);
			throw err;
		}
		await this.postReply(runKey, watch, key, { ...target, text: msg.text, blocks: msg.blocks }, "alert");
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

	/**
	 * Posts or updates the run's message in each target channel, or in the
	 * one channel `${team}:${channel}` only names, and replies for jobs that
	 * finished; with a passed push, its deploys folded in, and with deploy,
	 * that deploy's reply. A deploy run re-renders the message of the checks run that chained it instead.
	 */
	private async update(run: RunView, opts: { jobs?: JobView[]; only?: string; deploy?: DeployReplyEvent } = {}): Promise<void> {
		if (run.target !== "checks") {
			await this.foldDeploy(run.triggerId);
			return;
		}
		const { jobs = [], only, deploy } = opts;
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
		const deploys = run.state === "success" && run.event === "push" ? await loadDeployLines(this.env, this.t, runKey, run.sha) : undefined;
		const line = deploy && deploys?.find((s) => s.env === deploy.badge.env && s.runId === deploy.badge.runId);
		const deployed = deploy && line && { ...line, ...deploy.badge };

		for (const { watch, followOnly } of await this.targets(run, runKey, watches)) {
			if (only !== undefined && `${watch.team_id}:${watch.channel_id}` !== only) continue;
			try {
				const ts = await this.postOrUpdate(run, runKey, watch, followOnly, deploys);
				if (ts === null || followOnly) continue;
				if (watch.notify === "normal") for (const job of jobs) if (TERMINAL.has(job.state)) await this.reply(run, runKey, watch, ts, job);
				if (run.state === "failed") await this.alert(run, runKey, watch, ts, alertLog);
				if (deployed) await this.deployReply(run.repo, runKey, watch, ts, deployed, deploy.tail, run.authorLogin);
			} catch (err) {
				this.failed(err, { team_id: watch.team_id, channel_id: watch.channel_id, run_id: runKey });
			}
		}

		if (run.authorEmail) await this.learnAuthor(run, watches);
		if (TERMINAL.has(run.state) && this.host) await this.host.storage.delete(tailKey(runKey));
	}

	/**
	 * Where the run's message goes: each watch's channel, or with a
	 * .hookci.yml override the named channel in the watch's workspace, with
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
					logEvent("slack_override_unresolved", { team_id: watch.team_id, channel: slack.channel, run_id: runKey });
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
	private async postOrUpdate(run: RunView, runKey: string, watch: WatchRow, followOnly: boolean, deploys?: DeployBadgeState[]): Promise<string | null> {
		const { team_id: team, channel_id: channel } = watch;
		const msg = renderRunMessage(run, { notify: watch.notify, ...(deploys ? { deploys } : {}) });
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
		await this.postReply(runKey, watch, job.name, { channel, thread_ts: parentTs, text: msg.text, blocks: msg.blocks });
	}

	/**
	 * Posts a reply claimed under key in slack_job_replies and stores its ts;
	 * one left in the queue past 10 s keeps the claim, which
	 * completeQueuedSlackPost completes. Any other error releases the claim.
	 */
	private async postReply(runKey: string, watch: WatchRow, key: string, args: Record<string, unknown>, priority?: "alert"): Promise<void> {
		const { team_id: team, channel_id: channel } = watch;
		const claim: QueuedPostClaim = { kind: "reply", installationId: this.t.installationId, teamId: team, channelId: channel, runKey, job: key };
		try {
			const res = await slackApi(this.env, team, "chat.postMessage", args, { ...(priority ? { priority } : {}), claim: JSON.stringify(claim) });
			await setThreadReply(this.t, runKey, team, channel, key, String(res.ts));
		} catch (err) {
			if (err instanceof HubError && err.code === "slack_api" && err.message === "queue_deferred") {
				logEvent("slack_post_deferred", { run_id: runKey, team_id: team, channel_id: channel, job: key });
				return;
			}
			await releaseThreadReply(this.t, runKey, team, channel, key);
			throw err;
		}
	}

	/** The DM channel with a Slack user. */
	private async openDm(team: string, user: string): Promise<string> {
		const { channel: dm } = await slackApi(this.env, team, "conversations.open", { users: user }, { priority: "alert" });
		if (typeof dm !== "object" || dm === null || !("id" in dm) || typeof dm.id !== "string") {
			throw new HubError("slack_api", 502, "conversations_open_no_channel");
		}
		return dm.id;
	}

	/** A deploy author's Slack user: as for a run's author, else the Slack account linked to their GitHub login. */
	private async deployAuthor(team: string, login: string): Promise<string | null> {
		const known = await resolveAuthor(this.env, this.t.installationId, team, { login });
		if (known) return known;
		const linked = await this.env.DB.prepare("SELECT slack_user_id FROM user_links WHERE team_id = ?1 AND github_login = ?2 COLLATE NOCASE LIMIT 1")
			.bind(team, login)
			.first<{ slack_user_id: string }>();
		return linked?.slack_user_id ?? null;
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
			const { job, tail, logLink } = log;
			const author = await resolveAuthor(this.env, this.t.installationId, team, { login: run.authorLogin, email: run.authorEmail });
			let target = { channel, thread_ts: parentTs };
			const msg = renderAlert(run, job, tail, watch.alert === "dm" ? null : author, logLink);
			if (watch.alert === "dm" && author) target = { channel: await this.openDm(team, author), thread_ts: "" };
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
	 * last TAIL_LINES lines of the uploaded log with its stable link, else the
	 * tail the agent sent (kept in the AgentDO), else nothing.
	 */
	private async alertLog(run: RunView, runKey: string): Promise<AlertLog | null> {
		const stored = (await this.host?.storage.get<StoredTail>(tailKey(runKey))) ?? { job: "", tail: [], at: 0 };
		const found = run.jobs.find((j) => j.name === stored.job) ?? run.jobs.find((j) => j.state === "failed");
		if (!found) return null;
		const own = stored.job === found.name;
		const job: JobView = own && stored.logs ? { ...found, logs: stored.logs } : found;
		const fallback = { job, tail: own ? stored.tail : [], logLink: null };
		if (job.logs === "local" || !run.runId) return fallback;
		const tail = await getLogTail(this.env, run.runId, job.name, TAIL_LINES);
		if (!tail) return fallback;
		return { job, tail, logLink: stableLogLink(this.env, run.runId, job.name) };
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

	/** Runs fn after the Slack work queued on triggerId in this AgentDO; without a host, right away. */
	async inOrder(triggerId: string, fn: () => Promise<void>): Promise<void> {
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
 * A deploy reply's key in slack_job_replies, apart from job names by its
 * `#deploy:` prefix: one per env, attempt and step, rollback or end; null
 * for a state that gets no reply (queued, rejected).
 */
function deployReplyKey(s: DeployBadgeState): string | null {
	const at = `#deploy:${s.env}:${s.attempt ?? 1}:`;
	switch (s.state) {
		case "running":
			return s.stepIndex === undefined ? null : `${at}${s.stepIndex}`;
		case "rolling_back":
			return `${at}rollback`;
		case "failed":
			return `${at}failed`;
		case "succeeded":
		case "cancelled":
		case "interrupted":
		case "superseded":
			return `${at}done`;
		default:
			return null;
	}
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
	const run = await loadRunView(env, ref.installationId, ref.runKey === ref.triggerId ? { triggerId: ref.triggerId } : { runId: ref.runKey });
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
