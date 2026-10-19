// The Slack sink: in every channel watching the repo, or the channel the
// repo's .zeroci.yml notify.slack names in the watch's workspace, one message
// per run posted once and then updated in place, a thread reply per finished
// job (normal notify only), one alert when the run fails, and a DM to the
// agent's admin when it goes offline. It never reads channel history: what
// it posted is in slack_messages and slack_job_replies.

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
import type { Env } from "../env";
import { HubError } from "../errors";
import { logEvent, reportError } from "../observability";
import { slackApi, slackApiFireAndForget } from "../slack/api";
import { resolveAuthor } from "../slack/authors";
import { TERMINAL } from "../slack/badge";
import { findChannel } from "../slack/channels";
import { renderAlert, renderJobReply, renderOfflineDm, renderRunMessage } from "../slack/messages";
import { registerSinkFactory, type SinkHost } from "./index";
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

/** The failed job's tail as the agent sent it, kept in the AgentDO until the run ends. */
interface StoredTail {
	job: string;
	tail: string[];
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
		await this.inOrder(run.triggerId, () => this.update(run, job));
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

	private async update(run: RunView, job?: JobView): Promise<void> {
		const watches = (await listWatchesForRepo(this.t, run.repoId)).filter((w) => w.status === "active");
		if (watches.length === 0) return;
		if (run.runId) await adoptSlackMessages(this.t, run.triggerId, run.runId);
		const runKey = run.runId ?? run.triggerId;
		if (job?.state === "failed" && job.tail && job.tail.length > 0 && this.host) {
			const key = tailKey(runKey);
			if ((await this.host.storage.get(key)) === undefined) await this.host.storage.put(key, { job: job.name, tail: job.tail } satisfies StoredTail);
		}
		const tail = run.state === "failed" ? await this.alertTail(runKey) : undefined;

		for (const { watch, followOnly } of await this.targets(run, runKey, watches)) {
			try {
				const ts = await this.postOrUpdate(run, runKey, watch, followOnly);
				if (ts === null || followOnly) continue;
				if (job && watch.notify === "normal" && TERMINAL.has(job.state)) await this.reply(run, runKey, watch, ts, job);
				if (tail) await this.alert(run, runKey, watch, ts, tail);
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
	 * posted; returns its ts, or null when another call's first post has not
	 * answered yet or followOnly finds no message to update.
	 */
	private async postOrUpdate(run: RunView, runKey: string, watch: WatchRow, followOnly: boolean): Promise<string | null> {
		const { team_id: team, channel_id: channel } = watch;
		const msg = renderRunMessage(run, { notify: watch.notify });
		const priority = TERMINAL.has(run.state) ? "terminal" : "normal";
		let row = await getSlackMessage(this.t, runKey, team, channel);
		if (!row && followOnly) return null;
		if (!row && (await claimSlackMessage(this.t, runKey, team, channel))) {
			try {
				const res = await slackApi(this.env, team, "chat.postMessage", { channel, text: msg.text, blocks: msg.blocks }, { priority });
				const ts = String(res.ts);
				await putSlackMessage(this.t, { run_id: runKey, team_id: team, channel_id: channel, ts });
				return ts;
			} catch (err) {
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
		try {
			const res = await slackApi(this.env, team, "chat.postMessage", { channel, thread_ts: parentTs, text: msg.text, blocks: msg.blocks });
			await setThreadReply(this.t, runKey, team, channel, job.name, String(res.ts));
		} catch (err) {
			await releaseThreadReply(this.t, runKey, team, channel, job.name);
			throw err;
		}
	}

	/** Posts the run's one failure alert for the watch: a DM to the author when asked and known, else in the thread. */
	private async alert(run: RunView, runKey: string, watch: WatchRow, parentTs: string, stored: StoredTail): Promise<void> {
		const job = run.jobs.find((j) => j.name === stored.job) ?? run.jobs.find((j) => j.state === "failed");
		if (!job) return;
		const { team_id: team, channel_id: channel } = watch;
		if (!(await claimAlert(this.t, runKey, team, channel))) return;
		const tail = stored.job === job.name ? stored.tail : [];
		const logUrl = run.logUrl ?? null;
		try {
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
	 * The failed job's last log lines for the alert: what the agent sent with
	 * the job's final state, or nothing outside the AgentDO. The one place to
	 * read the stored log once it is kept.
	 */
	private async alertTail(runKey: string): Promise<StoredTail> {
		return (await this.host?.storage.get<StoredTail>(tailKey(runKey))) ?? { job: "", tail: [] };
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
	return `slack:tail:${runKey}`;
}

export function slackSinkFactory(env: Env, installationId: number, host?: SinkHost): SlackSink {
	const now = host ? () => host.now() : () => (env.__TEST_CLOCK ?? systemClock).now();
	return new SlackSink(env, installationId, now, host);
}

registerSinkFactory("slack", slackSinkFactory);
