// One per Slack workspace. The Slack routes ack within Slack's 3 s limit and
// hand commands and actions here; the DO runs the registered handler and
// posts its reply to the interaction's response_url.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { HubError } from "../errors";
import { defaultFetcher } from "../http";
import { reportError } from "../observability";
import { type SlackActionRequest, type SlackCommandRequest, type SlackReply, actionFor, commandFor } from "../slack/registry";
import { S } from "../strings";

const FAILED_REPLY: SlackReply = { response_type: "ephemeral", text: S.slack.failed };

/** Calls `POST https://do/<path>` on the team's SlackWorkspaceDO, which answers once the handler ran. */
export async function callSlackDo(
	env: Env,
	teamId: string,
	call: { path: "command"; body: SlackCommandRequest } | { path: "action"; body: SlackActionRequest },
): Promise<void> {
	const stub = env.SLACK_DO.get(env.SLACK_DO.idFromName(teamId));
	const res = await stub.fetch(`https://do/${call.path}`, { method: "POST", body: JSON.stringify(call.body) });
	if (!res.ok) throw new HubError("slack_do_failed", 502, `SlackWorkspaceDO /${call.path} answered ${res.status}`);
}

/** One per Slack workspace (`SLACK_DO.idFromName(teamId)`). */
export class SlackWorkspaceDO extends DurableObject<Env> {
	override async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (request.method === "POST" && path === "/command") return this.command(await request.json<SlackCommandRequest>());
		if (request.method === "POST" && path === "/action") return this.action(await request.json<SlackActionRequest>());
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	private async command(req: SlackCommandRequest): Promise<Response> {
		const handler = commandFor(req.text);
		if (!handler) return Response.json({ error: "unknown_command" }, { status: 404 });
		let reply: SlackReply;
		try {
			reply = await handler({ ...req, env: this.env });
		} catch (err) {
			reportError(err, { team_id: req.teamId, command: req.text.trim().split(/\s+/, 1)[0] ?? "" });
			reply = FAILED_REPLY;
		}
		await this.postReply(req.teamId, req.responseUrl, reply);
		return new Response(null, { status: 204 });
	}

	private async action(req: SlackActionRequest): Promise<Response> {
		const handler = actionFor(req.actionId);
		if (!handler) return Response.json({ error: "unknown_action" }, { status: 404 });
		let reply: SlackReply | null;
		try {
			reply = await handler({ ...req, env: this.env });
		} catch (err) {
			reportError(err, { team_id: req.teamId, action_id: req.actionId });
			reply = FAILED_REPLY;
		}
		if (reply !== null && req.responseUrl !== null) await this.postReply(req.teamId, req.responseUrl, reply);
		return new Response(null, { status: 204 });
	}

	/** POSTs reply to responseUrl, once more if Slack answers 5xx; a final failure is reported. */
	private async postReply(teamId: string, responseUrl: string, reply: SlackReply): Promise<void> {
		const fetcher = this.env.__TEST_FETCHER ?? defaultFetcher;
		const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reply) };
		let res = await fetcher(responseUrl, init);
		if (res.status >= 500) res = await fetcher(responseUrl, init);
		if (!res.ok) reportError(new HubError("slack_response_url_failed", 502, `response_url answered ${res.status}`), { team_id: teamId });
	}
}
