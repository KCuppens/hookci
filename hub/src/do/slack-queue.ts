// The pure half of the SlackWorkspaceDO outbound queue: token buckets,
// latest-wins coalescing and the choice of the next call to send. The DO
// owns storage, timers and the Slack fetch.

export type SlackPriority = "alert" | "terminal" | "normal";

export interface SlackCall {
	/** A ULID. */
	id: string;
	/** The Web API method, as `chat.update`. */
	method: string;
	body: Record<string, unknown>;
	priority: SlackPriority;
	/** `${channel}:${ts}` for chat.update: a later call with the same key replaces a queued one. */
	coalesceKey?: string;
	/** The channel whose per-channel bucket chat.postMessage and chat.postEphemeral draw from. */
	channel?: string;
	enqueuedAt: number;
	/** Sends that failed with a 429, a 5xx or a network error. */
	attempts: number;
	/** Not sent before this time; set by the retry backoff after a 5xx or network error. */
	notBefore?: number;
	/**
	 * Opaque to the queue: the sink's claim on the post this call makes. Once
	 * the call's waiter gives up, the queue keeps the call and hands its result
	 * to completeQueuedSlackPost instead.
	 */
	claim?: string;
}

export interface SlackCallResult {
	ok: boolean;
	/** Slack's JSON answer when ok. */
	data?: unknown;
	/** Slack's error code, or the queue's own (workspace_inactive, queue_full, queue_timeout, queue_deferred). */
	error?: string;
	/** A later call with the same coalesceKey replaced this one before it was sent. */
	coalesced?: boolean;
	/** Accepted without waiting for the send. */
	queued?: boolean;
}

/** Sort rank: lower goes first. Also the `priority` column of the DO queue table. */
export const PRIORITY_RANK: Record<SlackPriority, number> = { alert: 0, terminal: 1, normal: 2 };

/** The priority of rank, the inverse of PRIORITY_RANK. */
export function priorityOfRank(rank: number): SlackPriority {
	return rank === 0 ? "alert" : rank === 1 ? "terminal" : "normal";
}

const CHANNEL_BUCKET_METHODS: Record<string, true> = { "chat.postMessage": true, "chat.postEphemeral": true };

/** The channel whose bucket call draws from, or undefined when only the workspace bucket applies. */
export function bucketChannel(call: SlackCall): string | undefined {
	return Object.hasOwn(CHANNEL_BUCKET_METHODS, call.method) ? call.channel : undefined;
}

/**
 * A token bucket in whole milliseconds: full at capacity, one token back
 * every 1 / refillPerMs ms. spend() may take it below zero; the debt is paid
 * back by refills before take() succeeds again.
 */
export class TokenBucket {
	private tokens: number;
	private refilledAt: number;
	private readonly msPerToken: number;

	constructor(
		private readonly capacity: number,
		refillPerMs: number,
		now: number,
	) {
		this.msPerToken = Math.round(1 / refillPerMs);
		this.tokens = capacity;
		this.refilledAt = now;
	}

	/** Takes a token if one is available at now. */
	take(now: number): boolean {
		this.refill(now);
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}

	/** Takes a token even when none is left, for calls that cannot wait. */
	spend(now: number): void {
		this.refill(now);
		this.tokens -= 1;
	}

	/** The earliest time from now on at which take() succeeds. */
	nextAvailableAt(now: number): number {
		this.refill(now);
		return this.tokens >= 1 ? now : this.refilledAt + (1 - this.tokens) * this.msPerToken;
	}

	// Refilling is idempotent for one now, so reads may refill too. A clock
	// that went backwards counts as no time passed since now.
	private refill(now: number): void {
		if (now <= this.refilledAt) {
			this.refilledAt = now;
			return;
		}
		const whole = Math.floor((now - this.refilledAt) / this.msPerToken);
		if (this.tokens + whole >= this.capacity) {
			this.tokens = this.capacity;
			this.refilledAt = now;
		} else {
			this.tokens += whole;
			this.refilledAt += whole * this.msPerToken;
		}
	}
}

/**
 * Adds incoming to queue. When a queued call has the same coalesceKey, the
 * incoming call takes its place instead (latest wins): incoming's id and body,
 * the earlier enqueuedAt, the higher priority, and the queued call's attempts
 * and backoff. Returns a new array; queue is not changed.
 */
export function coalesce(queue: SlackCall[], incoming: SlackCall): SlackCall[] {
	const at = incoming.coalesceKey === undefined ? -1 : queue.findIndex((c) => c.coalesceKey === incoming.coalesceKey);
	const queued = queue[at];
	if (queued === undefined) return [...queue, incoming];
	const merged: SlackCall = {
		...incoming,
		enqueuedAt: Math.min(queued.enqueuedAt, incoming.enqueuedAt),
		priority: PRIORITY_RANK[queued.priority] < PRIORITY_RANK[incoming.priority] ? queued.priority : incoming.priority,
		attempts: queued.attempts,
		notBefore: queued.notBefore,
	};
	return queue.map((c, i) => (i === at ? merged : c));
}

export interface Buckets {
	workspace: TokenBucket;
	/** Per-channel post buckets; a channel without one has a full bucket. */
	channels: ReadonlyMap<string, TokenBucket>;
	/** No call goes out before this time (a Slack Retry-After); 0 when not paused. */
	pausedUntil: number;
}

function sendableAt(call: SlackCall, buckets: Buckets, now: number): number {
	const channel = bucketChannel(call);
	const channelAt = channel === undefined ? now : (buckets.channels.get(channel)?.nextAvailableAt(now) ?? now);
	return Math.max(channelAt, call.notBefore ?? now);
}

/**
 * The call to send at now: alert before terminal before normal, then the
 * earliest enqueued, skipping calls whose channel bucket is empty or whose
 * backoff has not passed. Null while paused or the workspace bucket is empty.
 * Takes no tokens.
 */
export function pickNext(queue: SlackCall[], buckets: Buckets, now: number): SlackCall | null {
	if (buckets.pausedUntil > now || buckets.workspace.nextAvailableAt(now) > now) return null;
	let best: SlackCall | null = null;
	for (const call of queue) {
		if (sendableAt(call, buckets, now) > now) continue;
		if (
			best === null ||
			PRIORITY_RANK[call.priority] < PRIORITY_RANK[best.priority] ||
			(call.priority === best.priority && call.enqueuedAt < best.enqueuedAt)
		) {
			best = call;
		}
	}
	return best;
}

/** The earliest time after which pickNext can return a call of queue, or null for an empty queue. */
export function nextWakeAt(queue: SlackCall[], buckets: Buckets, now: number): number | null {
	if (queue.length === 0) return null;
	const base = Math.max(now, buckets.pausedUntil, buckets.workspace.nextAvailableAt(now));
	return Math.max(base, Math.min(...queue.map((call) => sendableAt(call, buckets, now))));
}
