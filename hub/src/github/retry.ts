import { HubError } from "../errors";

/**
 * GitHub asked us to wait longer than a request should block. retryAt is the
 * unix time in ms when the call may be retried, for example from a DO alarm.
 */
export class GitHubRateLimitedError extends HubError {
	constructor(readonly retryAt: number) {
		super("github_rate_limited", 503, `GitHub rate limit, retry at ${new Date(retryAt).toISOString()}`);
	}
}

export interface RetryOptions {
	/** Total attempts including the first. */
	maxAttempts?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	random?: () => number;
}

const MAX_IN_REQUEST_WAIT_MS = 30_000;
const RATE_LIMIT_JITTER_MS = 500;
const BACKOFF_BASE_MS = 1000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Wait =
	/** GitHub named the wait; jitter is added on top so it is never shortened. */
	| { kind: "told"; ms: number }
	/** Our own exponential backoff; full jitter picks a wait in [0, ms). */
	| { kind: "backoff"; ms: number };

function waitFor(res: Response, attempt: number, now: number): Wait | null {
	const { status, headers } = res;
	if (status === 429 || status === 403) {
		const retryAfter = Number(headers.get("retry-after") ?? Number.NaN);
		if (Number.isFinite(retryAfter)) return { kind: "told", ms: Math.max(0, retryAfter) * 1000 };
		const reset = Number(headers.get("x-ratelimit-reset") ?? Number.NaN);
		if (headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)) {
			return { kind: "told", ms: Math.max(0, reset * 1000 - now) };
		}
	}
	if (status === 429 || status >= 500) return { kind: "backoff", ms: BACKOFF_BASE_MS * 2 ** (attempt - 1) };
	return null;
}

/**
 * Calls fn until GitHub answers with something other than a rate limit or a
 * 5xx. Rate limits wait as long as GitHub says (plus up to 500 ms jitter),
 * 5xx backs off 1 s, 2 s, 4 s with full jitter. A wait over 30 s throws
 * GitHubRateLimitedError instead of sleeping; running out of attempts throws
 * github_unavailable.
 */
export async function withRetry(fn: () => Promise<Response>, opts: RetryOptions = {}): Promise<Response> {
	const { maxAttempts = 4, sleep = defaultSleep, now = Date.now, random = Math.random } = opts;
	for (let attempt = 1; ; attempt++) {
		const res = await fn();
		const wait = waitFor(res, attempt, now());
		if (wait === null) return res;
		await res.body?.cancel();
		if (wait.ms > MAX_IN_REQUEST_WAIT_MS) throw new GitHubRateLimitedError(now() + wait.ms);
		if (attempt >= maxAttempts) {
			throw new HubError("github_unavailable", 503, `GitHub answered ${res.status} after ${attempt} attempts`);
		}
		await sleep(wait.kind === "told" ? wait.ms + random() * RATE_LIMIT_JITTER_MS : random() * wait.ms);
	}
}
