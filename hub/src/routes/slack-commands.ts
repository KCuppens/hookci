// POST /slack/commands: the /zeroci slash command. Slack wants an answer
// within 3 s, so known subcommands are acked with "working on it" and run in
// the workspace's SlackWorkspaceDO, which posts the reply to response_url.

import type { Context } from "hono";
import { hitIpRate } from "../db/ip-rate";
import { systemClock } from "../do/clock";
import { callSlackDo } from "../do/slack-workspace";
import type { Env } from "../env";
import { HubError } from "../errors";
import { reportError } from "../observability";
import { quotaLimit } from "../quotas";
import { type SlackCommandRequest, type SlackReply, commandFor } from "../slack/registry";
import { readVerifiedSlackBody } from "../slack/verify";
import { S } from "../strings";

const MINUTE_MS = 60 * 1000;

function parseCommand(form: URLSearchParams): SlackCommandRequest {
	const teamId = form.get("team_id");
	const userId = form.get("user_id");
	const channelId = form.get("channel_id");
	const responseUrl = form.get("response_url");
	if (!teamId || !userId || !channelId || !responseUrl) throw new HubError("bad_request", 400);
	return { teamId, userId, channelId, text: form.get("text") ?? "", responseUrl, triggerId: form.get("trigger_id") ?? "" };
}

export async function slackCommands(c: Context<{ Bindings: Env }>): Promise<Response> {
	const env = c.env;
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const form = new URLSearchParams(await readVerifiedSlackBody(c.req.raw, env, now));
	if (form.get("ssl_check") === "1") return c.body(null, 200);
	const cmd = parseCommand(form);

	const rate = await hitIpRate(env.DB, `slackcmd:${cmd.teamId}`, quotaLimit(env, "slackCmdsPerMin"), MINUTE_MS, now);
	if (!rate.ok) return c.json({ response_type: "ephemeral", text: S.slack.slowDown } satisfies SlackReply);
	if (env.ROTATION_IN_PROGRESS) return c.json({ response_type: "ephemeral", text: S.slack.updating } satisfies SlackReply);

	if (!commandFor(cmd.text)) {
		const help = commandFor("");
		return c.json(help ? await help({ ...cmd, env }) : ({ response_type: "ephemeral", text: S.slack.help } satisfies SlackReply));
	}
	c.executionCtx.waitUntil(
		callSlackDo(env, cmd.teamId, { path: "command", body: cmd }).catch((err: unknown) => reportError(err, { team_id: cmd.teamId })),
	);
	return c.json({ response_type: "ephemeral", text: S.slack.working } satisfies SlackReply);
}
