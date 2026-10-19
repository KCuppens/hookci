// POST /github/webhook: verifies the signature before anything reads the
// body, dedupes by delivery id, rate limits per installation, answers 202 and
// runs the event's handler after the response.

import type { Context } from "hono";
import { type DeliveryRow, markDelivery, reclaimFailedDelivery, recordDelivery } from "../db/deliveries";
import { hitIpRate } from "../db/ip-rate";
import type { Env } from "../env";
import { HubError } from "../errors";
import { verifyGithubSignature } from "../github/verify";
import { logEvent, reportError } from "../observability";
import { QUOTAS } from "../quotas";
import { handlerFor, type WebhookHandler } from "../webhook/handlers";

// GitHub caps webhook payloads at 25 MB.
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const utf8 = new TextDecoder();

function installationIdOf(payload: unknown): number | null {
	if (typeof payload !== "object" || payload === null || !("installation" in payload)) return null;
	const installation = payload.installation;
	if (typeof installation !== "object" || installation === null || !("id" in installation)) return null;
	return typeof installation.id === "number" && Number.isSafeInteger(installation.id) ? installation.id : null;
}

async function runHandler(env: Env, handler: WebhookHandler, payload: unknown, delivery: DeliveryRow): Promise<void> {
	try {
		const result = await handler(env, payload);
		if (result.status === "dropped") await markDelivery(env.DB, delivery.delivery_id, "dropped", result.note);
	} catch (err) {
		reportError(err, {
			delivery_id: delivery.delivery_id,
			event: delivery.event,
			...(delivery.installation_id !== null ? { installation_id: delivery.installation_id } : {}),
		});
		await markDelivery(env.DB, delivery.delivery_id, "failed", err instanceof HubError ? err.code : "internal");
	}
}

export async function githubWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
	if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) throw new HubError("payload_too_large", 413);
	const raw = await c.req.arrayBuffer();
	if (raw.byteLength > MAX_BODY_BYTES) throw new HubError("payload_too_large", 413);

	const secrets = [c.env.GITHUB_WEBHOOK_SECRET, c.env.GITHUB_WEBHOOK_SECRET_PREVIOUS].filter((s): s is string => Boolean(s));
	if (!(await verifyGithubSignature(raw, c.req.header("x-hub-signature-256") ?? null, secrets))) {
		logEvent("webhook_bad_signature", { delivery_id: c.req.header("x-github-delivery") ?? "" });
		throw new HubError("bad_signature", 401);
	}

	const deliveryId = c.req.header("x-github-delivery");
	const event = c.req.header("x-github-event");
	if (!deliveryId || !event) throw new HubError("missing_delivery_headers", 400);
	let payload: unknown;
	try {
		payload = JSON.parse(utf8.decode(raw));
	} catch {
		throw new HubError("invalid_json", 400);
	}

	const db = c.env.DB;
	const now = Date.now();
	const delivery: DeliveryRow = {
		delivery_id: deliveryId,
		received_at: now,
		expires_at: now + DELIVERY_TTL_MS,
		event,
		installation_id: installationIdOf(payload),
		status: "processed",
		note: null,
	};
	if (!(await recordDelivery(db, delivery)) && !(await reclaimFailedDelivery(db, deliveryId))) {
		return c.json({ duplicate: true }, 200);
	}

	if (delivery.installation_id !== null) {
		const minute = Math.floor(now / MINUTE_MS);
		const rate = await hitIpRate(db, `inst:${delivery.installation_id}:${minute}`, QUOTAS.webhooksPerInstallationPerMin, MINUTE_MS, now);
		if (!rate.ok) {
			await markDelivery(db, deliveryId, "dropped", "rate_limited");
			return c.body(null, 202);
		}
	}

	const handler = handlerFor(event);
	if (handler) c.executionCtx.waitUntil(runHandler(c.env, handler, payload, delivery));
	return c.body(null, 202);
}
