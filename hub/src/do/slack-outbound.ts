// The outbound queue inside one SlackWorkspaceDO. Every Web API call made as
// the workspace's bot comes through here, so the workspace stays inside
// Slack's rate limits: a workspace token bucket, one post per second per
// channel, latest-wins chat.update coalescing, a priority lane for alerts and
// terminal updates, and a pause for as long as Slack's Retry-After says.

import { markWatchBroken } from "../db/watches";
import { setWorkspaceStatus } from "../db/workspaces";
import type { Env } from "../env";
import { HubError } from "../errors";
import { defaultFetcher } from "../http";
import { logEvent, reportError } from "../observability";
import { QUOTAS } from "../quotas";
import { completeQueuedSlackPost } from "../sinks/slack";
import { getBotToken } from "../slack/tokens";
import { S } from "../strings";
import { ulid } from "../ulid";
import { type Clock, systemClock } from "./clock";
import {
	type Buckets,
	bucketChannel,
	coalesce,
	nextWakeAt,
	PRIORITY_RANK,
	pickNext,
	priorityOfRank,
	type SlackCall,
	type SlackCallResult,
	TokenBucket,
} from "./slack-queue";
import { type SlackSendOutcome, sendSlack } from "./slack-send";

/** The body of `POST https://do/call`. */
export interface SlackCallRequest {
	teamId: string;
	call: SlackCall;
	/** Answer with the call's result instead of `{ ok: true, queued: true }`; see SlackOutbound.waiters. */
	wait: boolean;
}

/** The answer of `GET https://do/queue-stats`. */
export interface SlackQueueStats {
	depth: number;
	/** When the current Retry-After pause ends, or null when not paused. */
	paused_until: number | null;
	sent_last_minute: number;
	rate_limited_total: number;
	/** Calls dropped because the queue was full. */
	dropped_total: number;
}

/** A queue this much over slackQueueMax refuses even alert and terminal calls. */
const HARD_MAX = Math.ceil(QUOTAS.slackQueueMax * 1.2);
/** How long a waited call may stay queued before its waiter gets queue_timeout, or queue_deferred for a call with a claim. */
const WAIT_MS = 10_000;
const MINUTE_MS = 60_000;
const RETRY_BASE_MS = 1_000;

/** Interactive methods sent at once: Slack expires their trigger or code within seconds. They still spend a workspace token. */
const SEND_AT_ONCE: Record<string, true> = { "views.open": true, "oauth.v2.access": true, "auth.test": true };

/** Errors that mean the bot token is gone for good. */
const REVOKED_ERRORS: Record<string, true> = { invalid_auth: true, account_inactive: true, token_revoked: true };

/** getBotToken refusals: the workspace cannot send anything. */
const INACTIVE_CODES: Record<string, true> = { workspace_inactive: true, workspace_not_found: true };

/** Errors of a post or update that mean the bot can no longer use the channel. */
const CHANNEL_GONE: Record<string, true> = { channel_not_found: true, not_in_channel: true, is_archived: true };
const CHANNEL_POSTS: Record<string, true> = { "chat.postMessage": true, "chat.update": true };

type Outcome = SlackSendOutcome | { kind: "inactive"; error: string };

interface Waiter {
	resolve: (result: SlackCallResult) => void;
	/** Past this, a call still queued is answered queue_timeout and taken off the queue, or queue_deferred and kept when it carries a claim. */
	deadline: number;
}

type MetaKey = "schema_version" | "team_id" | "paused_until" | "rate_limited_total" | "dropped_total";

type QueueRow = {
	id: string;
	method: string;
	body: string;
	priority: number;
	coalesce_key: string | null;
	channel: string | null;
	enqueued_at: number;
	attempts: number;
	not_before: number;
	claim: string | null;
};

// Step i moves the schema from version i to i + 1. Append, never edit.
const MIGRATIONS: ((sql: SqlStorage) => void)[] = [
	(sql) => {
		sql.exec(
			`CREATE TABLE queue (id TEXT PRIMARY KEY, method TEXT NOT NULL, body TEXT NOT NULL, priority INTEGER NOT NULL,
			coalesce_key TEXT, channel TEXT, enqueued_at INTEGER NOT NULL, attempts INTEGER NOT NULL, not_before INTEGER NOT NULL DEFAULT 0)`,
		);
		sql.exec("CREATE UNIQUE INDEX queue_coalesce_key ON queue (coalesce_key) WHERE coalesce_key IS NOT NULL");
	},
	(sql) => {
		sql.exec("ALTER TABLE queue ADD COLUMN waited INTEGER NOT NULL DEFAULT 0");
	},
	(sql) => {
		sql.exec("ALTER TABLE queue ADD COLUMN claim TEXT");
	},
];

function toCall(row: QueueRow): SlackCall {
	const call: SlackCall = {
		id: row.id,
		method: row.method,
		body: JSON.parse(row.body) as Record<string, unknown>,
		priority: priorityOfRank(row.priority),
		enqueuedAt: row.enqueued_at,
		attempts: row.attempts,
	};
	if (row.coalesce_key !== null) call.coalesceKey = row.coalesce_key;
	if (row.channel !== null) call.channel = row.channel;
	if (row.not_before > 0) call.notBefore = row.not_before;
	if (row.claim !== null) call.claim = row.claim;
	return call;
}

export class SlackOutbound {
	private readonly sql: SqlStorage;
	private readonly workspaceBucket: TokenBucket;
	private readonly channelBuckets = new Map<string, TokenBucket>();
	/**
	 * The callers waiting on a call id: wait:true calls and calls sent at once.
	 * A call still queued at its waiter's deadline is answered queue_timeout and
	 * taken off the queue, so it is never sent; one with a claim is answered
	 * queue_deferred and stays queued, and the sink that claimed it gets its
	 * result through completeQueuedSlackPost. A call in flight is always
	 * answered with Slack's answer, however late. Either way a caller never
	 * gives up on a call that is sent later without handing it on.
	 */
	private readonly waiters = new Map<string, Waiter>();
	/** Ids of the calls being sent: off the queue, past every deadline and dropAll. */
	private readonly inFlight = new Set<string>();
	/** When each send of the last minute went out. */
	private sentAt: number[] = [];
	private draining: Promise<void> | null = null;
	/** A call arrived while a drain was deciding it had nothing to send. */
	private again = false;
	/** Bumped by purge: a drain that sees it change forgets its token and does not retry the call it had in flight. */
	private generation = 0;

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {
		this.sql = ctx.storage.sql;
		this.workspaceBucket = new TokenBucket(QUOTAS.slackWorkspacePerMin, QUOTAS.slackWorkspacePerMin / MINUTE_MS, this.clock.now());
		void ctx.blockConcurrencyWhile(async () => this.migrate());
	}

	private get clock(): Clock {
		return this.env.__TEST_CLOCK ?? systemClock;
	}

	/** Queues req.call and starts a drain; with req.wait, answers once the call is sent, failed, coalesced, dropped or timed out in the queue. */
	async call(req: SlackCallRequest): Promise<SlackCallResult> {
		if (this.meta("team_id") !== req.teamId) this.setMeta("team_id", req.teamId);
		const { call } = req;
		if (Object.hasOwn(SEND_AT_ONCE, call.method)) return this.sendAtOnce(req.teamId, call);
		const result = req.wait ? this.waitFor(call.id, this.clock.now() + WAIT_MS) : null;
		this.enqueue(call);
		this.ctx.waitUntil(this.kick());
		return result ?? { ok: true, queued: true };
	}

	stats(): SlackQueueStats {
		const now = this.clock.now();
		this.sentAt = this.sentAt.filter((at) => at > now - MINUTE_MS);
		const pausedUntil = Number(this.meta("paused_until") ?? 0);
		return {
			depth: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM queue").one().n,
			paused_until: pausedUntil > now ? pausedUntil : null,
			sent_last_minute: this.sentAt.length,
			rate_limited_total: Number(this.meta("rate_limited_total") ?? 0),
			dropped_total: Number(this.meta("dropped_total") ?? 0),
		};
	}

	/** The DO alarm: the earliest moment a queued call could be sent has come. */
	async alarm(): Promise<void> {
		await this.kick();
	}

	/** The workspace was uninstalled or its bot token revoked: drops every queued call and any retry of a call in flight. */
	async purge(): Promise<void> {
		this.generation++;
		this.dropAll("workspace_inactive");
		await this.ctx.storage.deleteAlarm();
	}

	private migrate(): void {
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
			const version = Number(this.meta("schema_version") ?? 0);
			for (const step of MIGRATIONS.slice(version)) step(this.sql);
			this.setMeta("schema_version", String(MIGRATIONS.length));
			// Waiters live in memory: the callers of these calls lost their answer when the last instance went away.
			// A deferred call is no longer waited and stays: its claim gets the result.
			this.sql.exec("DELETE FROM queue WHERE waited = 1");
		});
	}

	private meta(key: MetaKey): string | null {
		return this.sql.exec<{ value: string | null }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
	}

	private setMeta(key: MetaKey, value: string): void {
		this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
	}

	private bump(key: "rate_limited_total" | "dropped_total"): void {
		this.setMeta(key, String(Number(this.meta(key) ?? 0) + 1));
	}

	private waitFor(id: string, deadline: number): Promise<SlackCallResult> {
		return new Promise<SlackCallResult>((resolve) => this.waiters.set(id, { resolve, deadline }));
	}

	private settle(id: string, result: SlackCallResult): void {
		const waiter = this.waiters.get(id);
		this.waiters.delete(id);
		waiter?.resolve(result);
	}

	/** Answers call's waiter, or once its waiter gave up, hands the result to the sink that claimed the post. */
	private finish(call: Pick<SlackCall, "id" | "claim">, result: SlackCallResult): void {
		if (this.waiters.has(call.id) || call.claim === undefined) {
			this.settle(call.id, result);
			return;
		}
		// Not awaited: completing may queue calls on this workspace, which this drain sends.
		this.ctx.waitUntil(
			completeQueuedSlackPost(this.env, call.claim, result).catch((err: unknown) => reportError(err, { team_id: this.meta("team_id") ?? "" })),
		);
	}

	/**
	 * Answers the queued calls whose waiter's deadline has passed: a call with a
	 * claim stays queued and is answered queue_deferred, any other is taken off
	 * the queue and answered queue_timeout.
	 */
	private expireWaiters(now: number): void {
		for (const [id, waiter] of this.waiters) {
			if (waiter.deadline > now || this.inFlight.has(id)) continue;
			const deferred = this.sql.exec("UPDATE queue SET waited = 0 WHERE id = ? AND claim IS NOT NULL", id).rowsWritten > 0;
			if (!deferred) this.sql.exec("DELETE FROM queue WHERE id = ?", id);
			this.settle(id, { ok: false, error: deferred ? "queue_deferred" : "queue_timeout" });
		}
	}

	/** The earliest deadline of a waiter whose call is queued, or null. */
	private nextDeadline(): number | null {
		let next: number | null = null;
		for (const [id, waiter] of this.waiters) {
			if (!this.inFlight.has(id) && (next === null || waiter.deadline < next)) next = waiter.deadline;
		}
		return next;
	}

	private insert(call: SlackCall): void {
		this.sql.exec(
			"INSERT INTO queue (id, method, body, priority, coalesce_key, channel, enqueued_at, attempts, not_before, waited, claim) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			call.id,
			call.method,
			JSON.stringify(call.body),
			PRIORITY_RANK[call.priority],
			call.coalesceKey ?? null,
			call.channel ?? null,
			call.enqueuedAt,
			call.attempts,
			call.notBefore ?? 0,
			this.waiters.has(call.id) ? 1 : 0,
			call.claim ?? null,
		);
	}

	private queuedWithKey(coalesceKey: string | undefined): SlackCall | undefined {
		if (coalesceKey === undefined) return undefined;
		const row = this.sql.exec<QueueRow>("SELECT * FROM queue WHERE coalesce_key = ?", coalesceKey).toArray()[0];
		return row && toCall(row);
	}

	/** Puts merged in place of the queued call replaced, whose waiter learns it was coalesced. */
	private replace(replaced: SlackCall, merged: SlackCall): void {
		this.sql.exec("DELETE FROM queue WHERE id = ?", replaced.id);
		this.insert(merged);
		if (replaced.id !== merged.id) this.settle(replaced.id, { ok: true, coalesced: true });
	}

	private enqueue(call: SlackCall): void {
		const queued = this.queuedWithKey(call.coalesceKey);
		if (queued !== undefined) {
			const [merged] = coalesce([queued], call);
			if (merged !== undefined) this.replace(queued, merged);
			return;
		}
		const depth = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM queue").one().n;
		if (depth >= QUOTAS.slackQueueMax && !this.makeRoom(call, depth)) return;
		this.insert(call);
	}

	/**
	 * Drops the oldest normal call for incoming; alert and terminal calls get
	 * in over slackQueueMax up to HARD_MAX. False when incoming itself is dropped.
	 */
	private makeRoom(incoming: SlackCall, depth: number): boolean {
		const oldest = this.sql
			.exec<{ id: string; claim: string | null }>("SELECT id, claim FROM queue WHERE priority = ? ORDER BY enqueued_at LIMIT 1", PRIORITY_RANK.normal)
			.toArray()[0];
		if (oldest === undefined && incoming.priority !== "normal" && depth < HARD_MAX) return true;
		const dropped = oldest === undefined ? incoming : { id: oldest.id, claim: oldest.claim ?? undefined };
		this.sql.exec("DELETE FROM queue WHERE id = ?", dropped.id);
		this.bump("dropped_total");
		this.finish(dropped, { ok: false, error: "queue_full" });
		return oldest !== undefined;
	}

	/** Starts a drain unless one runs; a running drain looks at the queue again before it stops. */
	private kick(): Promise<void> {
		if (this.draining !== null) {
			this.again = true;
			return this.draining;
		}
		this.draining = this.drain()
			.catch((err: unknown) => reportError(err, { team_id: this.meta("team_id") ?? "" }))
			.finally(() => {
				this.draining = null;
			});
		return this.draining;
	}

	private buckets(): Buckets {
		return { workspace: this.workspaceBucket, channels: this.channelBuckets, pausedUntil: Number(this.meta("paused_until") ?? 0) };
	}

	/**
	 * Sends calls while the buckets allow, then sets the alarm for the next one
	 * that could go. The bot token is read once per drain and before any bucket
	 * is taken, so a call leaves at the moment its tokens are spent.
	 */
	private async drain(): Promise<void> {
		const teamId = this.meta("team_id") ?? "";
		let token: string | undefined;
		let generation = this.generation;
		for (;;) {
			this.again = false;
			if (generation !== this.generation) {
				generation = this.generation;
				token = undefined;
			}
			const now = this.clock.now();
			this.expireWaiters(now);
			const queue = this.sql.exec<QueueRow>("SELECT * FROM queue").toArray().map(toCall);
			const buckets = this.buckets();
			const next = pickNext(queue, buckets, now);
			if (next === null) {
				const wake = nextWakeAt(queue, buckets, now);
				const deadline = this.nextDeadline();
				if (wake === null && deadline === null) {
					// A one-token channel bucket with its token is the same as none.
					for (const [channel, bucket] of this.channelBuckets) if (bucket.nextAvailableAt(now) <= now) this.channelBuckets.delete(channel);
					await this.ctx.storage.deleteAlarm();
				} else {
					await this.ctx.storage.setAlarm(Math.min(wake ?? Infinity, deadline ?? Infinity));
				}
				if (this.again) continue;
				return;
			}
			if (token === undefined) {
				const resolved = await this.botToken(teamId);
				if (typeof resolved === "string") token = resolved;
				else {
					this.sql.exec("DELETE FROM queue WHERE id = ?", next.id);
					await this.handle(teamId, next, resolved, true);
				}
				// Time passed and calls may have arrived: pick again.
				continue;
			}
			this.workspaceBucket.take(now);
			const channel = bucketChannel(next);
			if (channel !== undefined) this.channelBucket(channel, now).take(now);
			// Off the queue while in flight, so a newer update for the same key queues behind it.
			this.sql.exec("DELETE FROM queue WHERE id = ?", next.id);
			this.inFlight.add(next.id);
			try {
				const outcome = await this.send(token, next);
				if (generation === this.generation) await this.handle(teamId, next, outcome, true);
				// Purged while in flight: answer with what Slack did, and never retry.
				else this.finish(next, outcome.kind === "ok" ? { ok: true, data: outcome.data } : { ok: false, error: "workspace_inactive" });
			} finally {
				this.inFlight.delete(next.id);
			}
		}
	}

	private channelBucket(channel: string, now: number): TokenBucket {
		let bucket = this.channelBuckets.get(channel);
		if (bucket === undefined) {
			bucket = new TokenBucket(1, QUOTAS.slackChannelPostPerSec / 1_000, now);
			this.channelBuckets.set(channel, bucket);
		}
		return bucket;
	}

	private async sendAtOnce(teamId: string, call: SlackCall): Promise<SlackCallResult> {
		const result = this.waitFor(call.id, Infinity);
		this.inFlight.add(call.id);
		try {
			const token = await this.botToken(teamId);
			if (typeof token === "string") {
				this.workspaceBucket.spend(this.clock.now());
				await this.handle(teamId, call, await this.send(token, call), false);
			} else {
				await this.handle(teamId, call, token, false);
			}
		} finally {
			this.inFlight.delete(call.id);
		}
		return result;
	}

	/** The decrypted bot token, or the outcome every call gets while it cannot be read. */
	private async botToken(teamId: string): Promise<string | Outcome> {
		try {
			return await getBotToken(this.env, teamId);
		} catch (err) {
			if (err instanceof HubError && Object.hasOwn(INACTIVE_CODES, err.code)) return { kind: "inactive", error: err.code };
			return { kind: "retryable", error: err instanceof Error ? err.message : String(err) };
		}
	}

	private send(token: string, call: SlackCall): Promise<SlackSendOutcome> {
		this.sentAt.push(this.clock.now());
		return sendSlack(token, call.method, call.body, this.env.__TEST_FETCHER ?? defaultFetcher);
	}

	/** Finishes call by outcome; with retry, a 429, 5xx or network error queues it again instead of failing it. */
	private async handle(teamId: string, call: SlackCall, outcome: Outcome, retry: boolean): Promise<void> {
		const now = this.clock.now();
		switch (outcome.kind) {
			case "ok":
				this.finish(call, { ok: true, data: outcome.data });
				return;
			case "rate_limited":
				this.setMeta("paused_until", String(now + outcome.retryAfter * 1_000));
				this.bump("rate_limited_total");
				logEvent("slack_rate_limited", { teamId, retryAfter: outcome.retryAfter });
				if (retry) this.retry(teamId, call, "ratelimited", undefined);
				else this.finish(call, { ok: false, error: "ratelimited" });
				return;
			case "retryable":
				if (retry) this.retry(teamId, call, outcome.error, now + RETRY_BASE_MS * 2 ** call.attempts);
				else this.finish(call, { ok: false, error: outcome.error });
				return;
			case "inactive":
				this.dropAll(outcome.error);
				this.finish(call, { ok: false, error: outcome.error });
				return;
			case "failed":
				if (Object.hasOwn(REVOKED_ERRORS, outcome.error)) {
					this.dropAll("workspace_inactive");
					this.finish(call, { ok: false, error: "workspace_inactive" });
					logEvent("slack_workspace_revoked", { teamId, error: outcome.error });
					await setWorkspaceStatus(this.env.DB, teamId, "revoked");
					return;
				}
				if (Object.hasOwn(CHANNEL_GONE, outcome.error) && Object.hasOwn(CHANNEL_POSTS, call.method) && typeof call.body.channel === "string") {
					await this.channelGone(teamId, call.body.channel, outcome.error);
				}
				if (!this.waiters.has(call.id)) logEvent("slack_call_failed", { teamId, method: call.method, error: outcome.error });
				this.finish(call, { ok: false, error: outcome.error });
				return;
		}
	}

	/**
	 * A post or update found its channel unusable: breaks the channel's watches
	 * so sinks stop posting there, and queues one DM to each creator of a
	 * watch it broke. The drain sending this call sends the DMs too.
	 */
	private async channelGone(teamId: string, channel: string, error: string): Promise<void> {
		const creators = await markWatchBroken(this.env.DB, teamId, channel, error);
		if (creators.length === 0) return;
		logEvent("slack_watch_broken", { teamId, channel, error });
		const now = this.clock.now();
		for (const user of creators) {
			this.enqueue({
				id: ulid(now),
				method: "chat.postMessage",
				body: { channel: user, text: S.slack.watchBroken(channel, error) },
				priority: "normal",
				enqueuedAt: now,
				attempts: 0,
				channel: user,
			});
		}
	}

	/** Queues call again with one more attempt, or drops it once it has failed slackMaxAttempts times. */
	private retry(teamId: string, call: SlackCall, error: string, notBefore: number | undefined): void {
		const attempts = call.attempts + 1;
		if (attempts >= QUOTAS.slackMaxAttempts) {
			reportError(new HubError("slack_call_dropped", 502, `${call.method} failed ${attempts} times: ${error}`), { team_id: teamId, method: call.method });
			this.finish(call, { ok: false, error });
			return;
		}
		const again: SlackCall = { ...call, attempts, notBefore };
		const newer = this.queuedWithKey(call.coalesceKey);
		if (newer === undefined) {
			this.insert(again);
			return;
		}
		// A newer update for the same key queued meanwhile: it wins, in this call's slot.
		const [merged] = coalesce([again], newer);
		if (merged !== undefined) this.replace(newer, merged);
		this.settle(call.id, { ok: true, coalesced: true });
	}

	/** Empties the queue and fails every queued call with error. Calls in flight are not queued: Slack's answer finishes them. */
	private dropAll(error: string): void {
		const dropped = this.sql.exec<{ id: string; claim: string | null }>("SELECT id, claim FROM queue").toArray();
		this.sql.exec("DELETE FROM queue");
		for (const row of dropped) this.finish({ id: row.id, claim: row.claim ?? undefined }, { ok: false, error });
	}
}
