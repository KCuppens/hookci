// zeroci-hub: the Cloudflare Worker that receives GitHub webhooks, holds the
// agent WebSockets (AgentDO) and reports to Slack and GitHub Checks.

import { Hono, type Context } from "hono";
import { runCron } from "./cron";
import type { Env } from "./env";
import { HubError } from "./errors";
import { reportError } from "./observability";
import { githubWebhook } from "./routes/github-webhook";
import { agentConnect } from "./routes/agent-connect";
import { pairRedeem } from "./routes/pair";
import { githubOAuthCallback } from "./routes/github-oauth";
import { slackCommands } from "./routes/slack-commands";
import { slackEvents } from "./routes/slack-events";
import { slackInstall, slackOAuthCallback } from "./routes/slack-install";
import { slackInteractive } from "./routes/slack-interactive";
import { start, startStatus } from "./routes/start";
import "./webhook/installation";

export { AgentDO } from "./do/agent";
export { SlackWorkspaceDO } from "./do/slack-workspace";

type AppEnv = { Bindings: Env };

/** Answers HubError with `{"error": code}` and its status; anything else is reported and answered 500. */
export function handleError(err: Error, c: Context<AppEnv>): Response {
	if (err instanceof HubError) return Response.json({ error: err.code }, { status: err.status });
	reportError(err, { method: c.req.method, path: c.req.path });
	return c.json({ error: "internal" }, 500);
}

const app = new Hono<AppEnv>();

app.get("/healthz", (c) => c.json({ ok: true, version: c.env.HUB_VERSION }));
app.post("/github/webhook", githubWebhook);
app.get("/v1/agent/connect", agentConnect);
app.post("/v1/pair/redeem", pairRedeem);
app.get("/start", start);
app.get("/start/status", startStatus);
app.get("/github/oauth/callback", githubOAuthCallback);
app.get("/slack/install", slackInstall);
app.get("/slack/oauth/callback", slackOAuthCallback);
app.post("/slack/events", slackEvents);
app.post("/slack/commands", slackCommands);
app.post("/slack/interactive", slackInteractive);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError(handleError);

export default {
	fetch: app.fetch,
	async scheduled(event, env) {
		await runCron(env, event.cron);
	},
} satisfies ExportedHandler<Env>;
