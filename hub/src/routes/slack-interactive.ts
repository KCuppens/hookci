// POST /slack/interactive: button clicks, menu choices and modal submissions.
// Acks at once and runs each action's registered handler in the workspace's
// SlackWorkspaceDO, which posts any reply to response_url.

import type { Context } from "hono";
import { systemClock } from "../do/clock";
import { callSlackDo } from "../do/slack-workspace";
import type { Env } from "../env";
import { HubError } from "../errors";
import { logEvent, reportError } from "../observability";
import { type SlackActionRequest, actionFor } from "../slack/registry";
import { readVerifiedSlackBody } from "../slack/verify";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** obj[key] when it is a string. */
function str(obj: unknown, key: string): string | undefined {
	if (!isObject(obj)) return undefined;
	const value = obj[key];
	return typeof value === "string" ? value : undefined;
}

export async function slackInteractive(c: Context<{ Bindings: Env }>): Promise<Response> {
	const env = c.env;
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const payloadJson = new URLSearchParams(await readVerifiedSlackBody(c.req.raw, env, now)).get("payload");
	if (payloadJson === null) throw new HubError("bad_request", 400);
	let payload: unknown;
	try {
		payload = JSON.parse(payloadJson);
	} catch {
		throw new HubError("invalid_json", 400);
	}
	if (!isObject(payload)) throw new HubError("bad_request", 400);

	const teamId = str(payload.team, "id") ?? str(payload.user, "team_id");
	const userId = str(payload.user, "id");
	if (!teamId || !userId) throw new HubError("bad_request", 400);
	const dispatch = (body: SlackActionRequest): void => {
		if (!actionFor(body.actionId)) {
			logEvent("slack_unknown_action", { team_id: teamId, action_id: body.actionId });
			return;
		}
		c.executionCtx.waitUntil(
			callSlackDo(env, teamId, { path: "action", body }).catch((err: unknown) =>
				reportError(err, { team_id: teamId, action_id: body.actionId }),
			),
		);
	};
	const base = { teamId, userId, triggerId: str(payload, "trigger_id") ?? "" };

	if (payload.type === "block_actions") {
		if (!Array.isArray(payload.actions)) throw new HubError("bad_request", 400);
		const channelId = str(payload.channel, "id");
		const messageTs = str(payload.message, "ts") ?? str(payload.container, "message_ts");
		for (const action of payload.actions) {
			const actionId = str(action, "action_id");
			if (actionId === undefined) continue;
			dispatch({
				...base,
				actionId,
				value: str(action, "value") ?? str(isObject(action) ? action.selected_option : undefined, "value") ?? "",
				responseUrl: str(payload, "response_url") ?? null,
				...(payload.view !== undefined ? { view: payload.view } : {}),
				...(channelId !== undefined ? { channelId } : {}),
				...(messageTs !== undefined ? { messageTs } : {}),
			});
		}
		return c.body(null, 200);
	}
	if (payload.type === "view_submission") {
		const actionId = str(payload.view, "callback_id");
		if (actionId === undefined) throw new HubError("bad_request", 400);
		dispatch({ ...base, actionId, value: str(payload.view, "private_metadata") ?? "", responseUrl: null, view: payload.view });
		return c.json({ response_action: "clear" });
	}
	return c.body(null, 200);
}
