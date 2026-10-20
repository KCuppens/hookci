// The one place that POSTs to the Slack Web API with a bot token. Arguments
// go form-encoded, which every Web API method accepts (read methods such as
// conversations.info take no JSON bodies); objects and arrays such as blocks
// are sent as JSON strings.

import type { Fetcher } from "../http";

const DEFAULT_RETRY_AFTER_S = 30;

export type SlackSendOutcome =
	/** Slack answered `ok: true`. */
	| { kind: "ok"; data: Record<string, unknown> }
	/** HTTP 429 or `error: "ratelimited"`; retry no sooner than retryAfter seconds. */
	| { kind: "rate_limited"; retryAfter: number }
	/** Slack refused the call (`ok: false`); sending it again will not help. */
	| { kind: "failed"; error: string }
	/** A 5xx or a network error; the call may succeed later. */
	| { kind: "retryable"; error: string };

function retryAfterSeconds(res: Response): number {
	const seconds = Number(res.headers.get("retry-after"));
	return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_S;
}

/** Calls `https://slack.com/api/<method>` with token and classifies the answer. */
export async function sendSlack(token: string, method: string, body: Record<string, unknown>, fetcher: Fetcher): Promise<SlackSendOutcome> {
	const form = new URLSearchParams();
	for (const [name, value] of Object.entries(body)) {
		if (value === undefined) continue;
		form.set(name, typeof value === "string" ? value : JSON.stringify(value));
	}
	let res: Response;
	try {
		res = await fetcher(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
			body: form,
		});
	} catch (err) {
		return { kind: "retryable", error: err instanceof Error ? err.message : String(err) };
	}
	if (res.status === 429) return { kind: "rate_limited", retryAfter: retryAfterSeconds(res) };
	if (res.status >= 500) return { kind: "retryable", error: `http ${res.status}` };
	let data: { ok?: unknown; error?: unknown };
	try {
		data = await res.json<{ ok?: unknown; error?: unknown }>();
	} catch {
		return { kind: "failed", error: `http ${res.status}` };
	}
	if (data.ok === true) return { kind: "ok", data };
	if (data.error === "ratelimited") return { kind: "rate_limited", retryAfter: retryAfterSeconds(res) };
	return { kind: "failed", error: typeof data.error === "string" ? data.error : `http ${res.status}` };
}
