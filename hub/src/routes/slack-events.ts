// POST /slack/events: the Events API. Verifies the signature before parsing,
// answers url_verification and ssl_check, dedupes event_callback by event_id
// and runs the registered handler after the 200.

import type { Context } from "hono";
import { recordSlackEvent } from "../db/deliveries";
import { getWorkspace } from "../db/workspaces";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { logEvent, reportError } from "../observability";
import { type EventHandler, eventHandlerFor } from "../slack/registry";
import { readVerifiedSlackBody } from "../slack/verify";

// Slack retries a delivery for up to about an hour; a day covers every retry.
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runEventHandler(env: Env, handler: EventHandler, teamId: string, eventId: string, event: Record<string, unknown>): Promise<void> {
	try {
		await handler(env, teamId, event);
	} catch (err) {
		reportError(err, { team_id: teamId, event_id: eventId, event_type: String(event.type) });
	}
}

export async function slackEvents(c: Context<{ Bindings: Env }>): Promise<Response> {
	const env = c.env;
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const raw = await readVerifiedSlackBody(c.req.raw, env, now);
	if (c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) {
		if (new URLSearchParams(raw).get("ssl_check") === "1") return c.body(null, 200);
		throw new HubError("bad_request", 400);
	}

	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		throw new HubError("invalid_json", 400);
	}
	if (!isObject(body)) throw new HubError("bad_request", 400);

	if (body.type === "url_verification") {
		if (typeof body.challenge !== "string") throw new HubError("bad_request", 400);
		return c.json({ challenge: body.challenge });
	}
	if (body.type !== "event_callback") return c.body(null, 200);

	const { team_id: teamId, event_id: eventId, event } = body;
	if (typeof teamId !== "string" || typeof eventId !== "string" || !isObject(event) || typeof event.type !== "string") {
		throw new HubError("bad_request", 400);
	}
	if (!(await getWorkspace(env.DB, teamId))) {
		logEvent("slack_unknown_team", { team_id: teamId, event_id: eventId });
		return c.body(null, 200);
	}
	if (!(await recordSlackEvent(env.DB, eventId, now + EVENT_TTL_MS))) return c.body(null, 200);

	const handler = eventHandlerFor(event.type);
	if (handler) c.executionCtx.waitUntil(runEventHandler(env, handler, teamId, eventId, event));
	return c.body(null, 200);
}
