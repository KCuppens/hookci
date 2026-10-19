// The outbound queue inside one SlackWorkspaceDO. Every Web API call made as
// the workspace's bot comes through here, so the workspace stays inside
// Slack's rate limits: a workspace token bucket, one post per second per
// channel, latest-wins chat.update coalescing, a priority lane for alerts and
// terminal updates, and a pause for as long as Slack's Retry-After says.

import { setWorkspaceStatus } from "../db/workspaces";
import type { Env } from "../env";
import { HubError } from "../errors";
import { defaultFetcher } from "../http";
import { logEvent, reportError } from "../observability";
import { QUOTAS } from "../quotas";
import { getBotToken } from "../slack/tokens";
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
	/** Answer with the call's result (within WAIT_MS) instead of `{ ok: true, queued: true }`. */
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

const WAIT_MS = 10_000;
const MINUTE_MS = 60_000;
const RETRY_BASE_MS = 1_000;

/** Interactive methods sent at once: Slack expires their trigger or code within seconds. They still spend a workspace token. */
const SEND_AT_ONCE: Record<string, true> = { "views.open": true, "oauth.v2.access": true, "auth.test": true };

/** Errors that mean the bot token is gone for good. */
const REVOKED_ERRORS: Record<string, true> = { invalid_auth: true, account_inactive: true, token_revoked: true };

/** getBotToken refusals: the workspace cannot send anything. */
const INACTIVE_CODES: Record<string, true> = { workspace_inactive: true, workspace_not_found: true };

type Outcome = SlackSendOutcome | { kind: "inactive"; error: string };

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
	return call;
}

export class SlackOutbound {
	private readonly sql: SqlStorage;
	private readonly workspaceBucket: TokenBucket;
	private readonly channelBuckets = new Map<string, TokenBucket>();
	/** Resolves the caller waiting on a call id: wait:true calls and calls sent at once. */
	private readonly waiters = new Map<string, (result: SlackCallResult) => void>();
	/** When each send of the last minute went out. */
	private sentAt: number[] = [];
	private draining: Promise<void> | null = null;
	/** A call arrived while a drain was deciding it had nothing to send. */
	private again = false;

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

	/** Queues req.call and starts a drain; with req.wait, answers once the call is sent, failed, coalesced or timed out. */
	async call(req: SlackCallRequest): Promise<SlackCallResult> {
		if (this.meta("team_id") !== req.teamId) this.setMeta("team_id", req.teamId);
		const { call } = req;
		if (Object.hasOwn(SEND_AT_ONCE, call.method)) return this.sendAtOnce(req.teamId, call);
		const result = req.wait ? new Promise<SlackCallResult>((resolve) => this.waiters.set(call.id, resolve)) : null;
		this.enqueue(call);
		this.ctx.waitUntil(this.kick());
		return result === null ? { ok: true, queued: true } : this.awaitResult(call.id, result);
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

	private migrate(): void {
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
			const version = Number(this.meta("schema_version") ?? 0);
			for (const step of MIGRATIONS.slice(version)) step(this.sql);
			this.setMeta("schema_version", String(MIGRATIONS.length));
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

	private settle(id: string, result: SlackCallResult): void {
		const resolve = this.waiters.get(id);
		this.waiters.delete(id);
		resolve?.(result);
	}

	private async awaitResult(id: string, result: Promise<SlackCallResult>): Promise<SlackCallResult> {
		let timer = 0;
		const timeout = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), WAIT_MS);
		});
		const settled = await Promise.race([result, timeout]);
		clearTimeout(timer);
		if (settled !== null) return settled;
		// Still queued: take it back so it does not go out after the caller gave up.
		this.waiters.delete(id);
		this.sql.exec("DELETE FROM queue WHERE id = ?", id);
		return { ok: false, error: "queue_timeout" };
	}

	private insert(call: SlackCall): void {
		this.sql.exec(
			"INSERT INTO queue (id, method, body, priority, coalesce_key, channel, enqueued_at, attempts, not_before) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			call.id,
			call.method,
			JSON.stringify(call.body),
			PRIORITY_RANK[call.priority],
			call.coalesceKey ?? null,
			call.channel ?? null,
			call.enqueuedAt,
			call.attempts,
			call.notBefore ?? 0,
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
		if (depth >= QUOTAS.slackQueueMax && !this.makeRoom(call)) return;
		this.insert(call);
	}

	/** Drops the oldest normal call for incoming; alert and terminal calls always get in. False when incoming itself is dropped. */
	private makeRoom(incoming: SlackCall): boolean {
		const oldest = this.sql
			.exec<{ id: string }>("SELECT id FROM queue WHERE priority = ? ORDER BY enqueued_at LIMIT 1", PRIORITY_RANK.normal)
			.toArray()[0];
		if (oldest === undefined && incoming.priority !== "normal") return true;
		const dropped = oldest?.id ?? incoming.id;
		this.sql.exec("DELETE FROM queue WHERE id = ?", dropped);
		this.bump("dropped_total");
		this.settle(dropped, { ok: false, error: "queue_full" });
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
		for (;;) {
			this.again = false;
			const now = this.clock.now();
			const queue = this.sql.exec<QueueRow>("SELECT * FROM queue").toArray().map(toCall);
			const buckets = this.buckets();
			const next = pickNext(queue, buckets, now);
			if (next === null) {
				const wake = nextWakeAt(queue, buckets, now);
				if (wake === null) {
					// A one-token channel bucket with its token is the same as none.
					for (const [channel, bucket] of this.channelBuckets) if (bucket.nextAvailableAt(now) <= now) this.channelBuckets.delete(channel);
					await this.ctx.storage.deleteAlarm();
				} else {
					await this.ctx.storage.setAlarm(wake);
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
			await this.handle(teamId, next, await this.send(token, next), true);
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
		const result = new Promise<SlackCallResult>((resolve) => this.waiters.set(call.id, resolve));
		const token = await this.botToken(teamId);
		if (typeof token === "string") {
			this.workspaceBucket.spend(this.clock.now());
			await this.handle(teamId, call, await this.send(token, call), false);
		} else {
			await this.handle(teamId, call, token, false);
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

	/** Settles call by outcome; with retry, a 429, 5xx or network error queues it again instead of failing it. */
	private async handle(teamId: string, call: SlackCall, outcome: Outcome, retry: boolean): Promise<void> {
		const now = this.clock.now();
		switch (outcome.kind) {
			case "ok":
				this.settle(call.id, { ok: true, data: outcome.data });
				return;
			case "rate_limited":
				this.setMeta("paused_until", String(now + outcome.retryAfter * 1_000));
				this.bump("rate_limited_total");
				logEvent("slack_rate_limited", { teamId, retryAfter: outcome.retryAfter });
				if (retry) this.retry(teamId, call, "ratelimited", undefined);
				else this.settle(call.id, { ok: false, error: "ratelimited" });
				return;
			case "retryable":
				if (retry) this.retry(teamId, call, outcome.error, now + RETRY_BASE_MS * 2 ** call.attempts);
				else this.settle(call.id, { ok: false, error: outcome.error });
				return;
			case "inactive":
				this.dropAll(outcome.error);
				return;
			case "failed":
				if (Object.hasOwn(REVOKED_ERRORS, outcome.error)) {
					this.dropAll("workspace_inactive");
					logEvent("slack_workspace_revoked", { teamId, error: outcome.error });
					await setWorkspaceStatus(this.env.DB, teamId, "revoked");
					return;
				}
				if (!this.waiters.has(call.id)) logEvent("slack_call_failed", { teamId, method: call.method, error: outcome.error });
				this.settle(call.id, { ok: false, error: outcome.error });
				return;
		}
	}

	/** Queues call again with one more attempt, or drops it once it has failed slackMaxAttempts times. */
	private retry(teamId: string, call: SlackCall, error: string, notBefore: number | undefined): void {
		const attempts = call.attempts + 1;
		if (attempts >= QUOTAS.slackMaxAttempts) {
			reportError(new HubError("slack_call_dropped", 502, `${call.method} failed ${attempts} times: ${error}`), { team_id: teamId, method: call.method });
			this.settle(call.id, { ok: false, error });
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

	/** Empties the queue and fails every waiter with error. */
	private dropAll(error: string): void {
		this.sql.exec("DELETE FROM queue");
		for (const id of [...this.waiters.keys()]) this.settle(id, { ok: false, error });
	}
}
