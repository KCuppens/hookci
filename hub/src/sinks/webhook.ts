// The generic webhook sink: a versioned JSON payload POSTed to a user's HTTPS
// endpoint, signed with HMAC-SHA256 over `${timestamp}.${body}` under the
// sink's hub-generated secret, delivered by the SinkOutboxDO. Each run-level
// state goes out once (the last one delivered is kept in
// sink_messages.last_hash). The URL check works on the literal host only: the
// Worker does no DNS resolution, so a name that resolves to a private address
// is stopped by Cloudflare's egress, which does not reach private ranges.

import { hex, hmacSha256 } from "../crypto";
import { getSinkMessage, putSinkMessage } from "../db/sinks";
import { tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import { defaultFetcher, PROVIDER_TIMEOUT_MS } from "../http";
import { TERMINAL } from "../slack/badge";
import { type Deliverer, type DeliveryResult, registerDeliverer } from "./deliverers";
import { logJob } from "./runview";
import type { RunView } from "./types";

export interface WebhookPayloadV1 {
	v: 1;
	type: "run.updated";
	delivery_id: string;
	sent_at: string;
	run: {
		id: string;
		repo: string;
		sha: string;
		ref: string;
		event: "push" | "pull_request" | "manual";
		pr: number | null;
		target: string | null;
		state: string;
		terminal: boolean;
		jobs: { name: string; state: string; duration_ms: number | null }[];
		started_at: string | null;
		finished_at: string | null;
		log_url: string | null;
	};
}

export const WEBHOOK_EVENT = "run.updated";
export const WEBHOOK_USER_AGENT = "HookCI-Hookshot/1";
export function buildWebhookPayload(run: RunView, deliveryId: string, now: Date): WebhookPayloadV1 {
	return {
		v: 1,
		type: WEBHOOK_EVENT,
		delivery_id: deliveryId,
		sent_at: now.toISOString(),
		run: {
			id: run.runId ?? run.triggerId,
			repo: run.repo,
			sha: run.sha,
			ref: run.ref ?? "",
			event: run.event,
			pr: run.prNumber ?? null,
			target: run.target || null,
			state: run.state,
			terminal: TERMINAL.has(run.state),
			jobs: run.jobs.map((j) => ({ name: j.name, state: j.state, duration_ms: j.durationMs ?? null })),
			started_at: run.startedAt === undefined ? null : new Date(run.startedAt).toISOString(),
			finished_at: run.finishedAt === undefined ? null : new Date(run.finishedAt).toISOString(),
			log_url: logJob(run)?.logLink ?? null,
		},
	};
}

/** `sha256=` and the lowercase hex HMAC-SHA256 of `${timestamp}.${body}` under secret. */
export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
	return `sha256=${hex(await hmacSha256(secret, `${timestamp}.${body}`))}`;
}

export function generateWebhookSecret(): string {
	return `hciwh_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export type WebhookUrlCheck = { ok: true; url: URL } | { ok: false; code: "invalid" | "not_https" | "private_host" | "self" };

type Octets = [number, number, number, number];

/** The four octets of a dotted-quad host, or null when host is not one. */
function parseIPv4(host: string): Octets | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return null;
	const octets: Octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	return octets.every((n) => n <= 255) ? octets : null;
}

/** The eight 16-bit groups of an IPv6 literal (brackets removed), or null when it is not one. */
function parseIPv6(host: string): number[] | null {
	let s = host;
	const lastColon = s.lastIndexOf(":");
	if (s.slice(lastColon + 1).includes(".")) {
		const v4 = parseIPv4(s.slice(lastColon + 1));
		if (!v4) return null;
		const [a, b, c, d] = v4;
		s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head = "", rest, ...extra] = s.split("::");
	if (extra.length > 0) return null;
	const groups = (part: string) => (part === "" ? [] : part.split(":"));
	const left = groups(head);
	const right = rest === undefined ? [] : groups(rest);
	if (![...left, ...right].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
	const fill = 8 - left.length - right.length;
	if (rest === undefined ? fill !== 0 : fill < 1) return null;
	return [...left, ...new Array<string>(fill).fill("0"), ...right].map((g) => Number.parseInt(g, 16));
}

function privateIPv4([a, b]: Octets): boolean {
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127)
	);
}

function privateIPv6(groups: number[]): boolean {
	const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, hi = 0, lo = 0] = groups;
	const zeroPrefix = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
	if (zeroPrefix && f === 0 && hi === 0 && lo === 1) return true; // ::1
	if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7
	if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10
	return zeroPrefix && f === 0xffff && privateIPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
}

/** Whether raw is an https URL a webhook may be sent to; hubHost is the hub's own host, which is refused. */
export function validateWebhookUrl(raw: string, hubHost: string): WebhookUrlCheck {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, code: "invalid" };
	}
	if (url.protocol !== "https:") return { ok: false, code: "not_https" };
	if (url.username !== "" || url.password !== "" || url.port !== "") return { ok: false, code: "invalid" };
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host === "") return { ok: false, code: "invalid" };
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
		return { ok: false, code: "private_host" };
	}
	if (host.startsWith("[")) {
		const groups = parseIPv6(host.slice(1, -1));
		if (!groups) return { ok: false, code: "invalid" };
		if (privateIPv6(groups)) return { ok: false, code: "private_host" };
	} else {
		const v4 = parseIPv4(host);
		if (v4 && privateIPv4(v4)) return { ok: false, code: "private_host" };
	}
	if (host === hubHost.toLowerCase().replace(/\.$/, "")) return { ok: false, code: "self" };
	return { ok: true, url };
}

/** The Retry-After header as milliseconds, when it is a whole number of seconds. */
function retryAfterMs(res: Response): number | undefined {
	const v = res.headers.get("Retry-After")?.trim();
	return v && /^\d+$/.test(v) ? Number(v) * 1000 : undefined;
}

function classify(res: Response): DeliveryResult {
	const httpStatus = res.status;
	if (httpStatus >= 200 && httpStatus < 300) return { kind: "ok" };
	if (httpStatus === 410) return { kind: "fail", httpStatus, disable: "webhook_gone" };
	if (httpStatus === 429) return { kind: "retry", httpStatus, afterMs: retryAfterMs(res) };
	if (httpStatus >= 500) return { kind: "retry", httpStatus };
	return { kind: "fail", httpStatus };
}

export const webhookDeliverer: Deliverer = {
	async deliver(env, cfg, item) {
		const t = tenantDb(env.DB, item.installationId);
		const state = item.payload.state;
		const last = item.test ? null : await getSinkMessage(t, cfg.id, item.runId);
		if (last?.lastHash === state) return { kind: "ok" };
		if (!cfg.secret) return { kind: "fail", disable: "webhook_no_secret" };
		const check = validateWebhookUrl(cfg.target, new URL(env.HUB_ORIGIN).hostname);
		if (!check.ok) return { kind: "fail", disable: `webhook_url_${check.code}` };

		const now = (env.__TEST_CLOCK ?? systemClock).now();
		const timestamp = Math.floor(now / 1000);
		const body = JSON.stringify(buildWebhookPayload(item.payload, item.deliveryId, new Date(now)));
		const fetcher = env.__TEST_FETCHER ?? defaultFetcher;
		let res: Response;
		try {
			res = await fetcher(check.url.toString(), {
				method: "POST",
				redirect: "manual",
				signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
				headers: {
					"Content-Type": "application/json",
					"User-Agent": WEBHOOK_USER_AGENT,
					"X-HookCI-Event": WEBHOOK_EVENT,
					"X-HookCI-Delivery": item.deliveryId,
					"X-HookCI-Timestamp": String(timestamp),
					"X-HookCI-Signature": await signWebhook(cfg.secret, timestamp, body),
				},
				body,
			});
		} catch {
			return { kind: "retry" };
		}
		await res.body?.cancel();
		const result = classify(res);
		if (result.kind === "ok" && !item.test) await putSinkMessage(t, cfg.id, item.runId, { externalId: null, lastHash: state }, now);
		return result;
	},
};

registerDeliverer("webhook", webhookDeliverer);
