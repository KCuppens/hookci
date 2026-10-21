// Slack request signing (v0): HMAC-SHA256 over "v0:<timestamp>:<raw body>"
// under the signing secret, sent as X-Slack-Signature "v0=<hex>". Requests
// older or newer than 5 minutes are refused so a captured one cannot be replayed.

import { hex, hmacSha256, timingSafeEqual } from "../crypto";
import type { Env } from "../env";
import { HubError } from "../errors";
import { logEvent } from "../observability";

const MAX_SKEW_MS = 300 * 1000;
// Slack payloads are a few KB; a modal submission with every input filled
// stays far below this.
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Throws slack_stale (401) when the request timestamp is more than 300 s from
 * nowMs, and slack_bad_signature (401) when the signature is missing or no
 * secret in secrets produced it.
 */
export async function verifySlackRequest(rawBody: string, headers: Headers, secrets: string[], nowMs: number): Promise<void> {
	const timestamp = headers.get("x-slack-request-timestamp");
	const signature = headers.get("x-slack-signature");
	if (timestamp === null || !/^\d{1,12}$/.test(timestamp) || signature === null) throw new HubError("slack_bad_signature", 401);
	if (Math.abs(nowMs - Number(timestamp) * 1000) > MAX_SKEW_MS) throw new HubError("slack_stale", 401);
	const basestring = `v0:${timestamp}:${rawBody}`;
	for (const secret of secrets) {
		if (timingSafeEqual(`v0=${hex(await hmacSha256(secret, basestring))}`, signature)) return;
	}
	throw new HubError("slack_bad_signature", 401);
}

/** Reads req's body once and returns it after verifying Slack's signature; throws as verifySlackRequest does. */
export async function readVerifiedSlackBody(req: Request, env: Env, nowMs: number): Promise<string> {
	if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new HubError("payload_too_large", 413);
	// Decoded by hand: Request.text() warns on Slack's form bodies.
	const bytes = await req.arrayBuffer();
	if (bytes.byteLength > MAX_BODY_BYTES) throw new HubError("payload_too_large", 413);
	const raw = new TextDecoder().decode(bytes);
	try {
		const secrets = [env.SLACK_SIGNING_SECRET, env.SLACK_SIGNING_SECRET_PREVIOUS].filter((s): s is string => Boolean(s));
		await verifySlackRequest(raw, req.headers, secrets, nowMs);
	} catch (err) {
		if (err instanceof HubError) logEvent("slack_bad_request_signature", { code: err.code, path: new URL(req.url).pathname });
		throw err;
	}
	return raw;
}
