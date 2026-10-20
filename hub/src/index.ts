// zeroci-hub: the Cloudflare Worker that receives GitHub webhooks, holds the
// agent WebSockets (AgentDO) and reports to Slack and GitHub Checks.

import { app } from "./app";
import { runCron } from "./cron";
import type { Env } from "./env";
import "./slack/actions";
import "./slack/commands";
import "./slack/events";
import "./webhook/authorization";
import "./webhook/check-run";
import "./webhook/installation";
import "./sinks/checks";
import "./sinks/slack";
import "./sinks/webhook";
import "./sinks/telegram";

export { AgentDO } from "./do/agent";
export { SinkOutboxDO } from "./do/sink-outbox";
export { SlackWorkspaceDO } from "./do/slack-workspace";

export default {
	fetch: app.fetch,
	async scheduled(event, env) {
		await runCron(env, event.cron);
	},
} satisfies ExportedHandler<Env>;
