// The hub's HTTP routes. src/index.ts serves them as the Worker's fetch
// handler; the security suites read app.routes to check every route is covered.

import { type Context, Hono } from "hono";
import type { Env } from "./env";
import { HubError } from "./errors";
import { reportError } from "./observability";
import { agentConnect } from "./routes/agent-connect";
import { exportData } from "./routes/export";
import { githubLinkCallback, githubLinkConfirm, githubLinkStart } from "./routes/github-link";
import { githubOAuthCallback } from "./routes/github-oauth";
import { githubWebhook } from "./routes/github-webhook";
import { info } from "./routes/info";
import { install } from "./routes/install";
import { authGithubCallback, logLinks } from "./routes/log-links";
import { rawLog, streamLog, viewerScript, viewerStylesheet, viewLogPage } from "./routes/log-viewer";
import { uploadLog } from "./routes/logs";
import { pairRedeem } from "./routes/pair";
import { renderPreview } from "./routes/render";
import { addSink, listSinks, removeSink, testSink } from "./routes/sink-config";
import { slackCommands } from "./routes/slack-commands";
import { slackEvents } from "./routes/slack-events";
import { slackInstall, slackOAuthCallback } from "./routes/slack-install";
import { slackInteractive } from "./routes/slack-interactive";
import { start, startStatus } from "./routes/start";
import { handleWellKnown, WELL_KNOWN_PATHS } from "./routes/well-known";

type AppEnv = { Bindings: Env };

/** Answers HubError with `{"error": code}` and its status; anything else is reported and answered 500. */
export function handleError(err: Error, c: Context<AppEnv>): Response {
	if (err instanceof HubError) return Response.json({ error: err.code }, { status: err.status });
	reportError(err, { method: c.req.method, path: c.req.path });
	return c.json({ error: "internal" }, 500);
}

export const app = new Hono<AppEnv>();

app.get("/healthz", (c) => c.json({ ok: true, version: c.env.HUB_VERSION }));
app.get("/v1/info", info);
app.get("/install", install);
app.post("/github/webhook", githubWebhook);
app.get("/v1/agent/connect", agentConnect);
app.post("/v1/pair/redeem", pairRedeem);
app.get("/start", start);
app.get("/start/status", startStatus);
app.get("/github/oauth/callback", githubOAuthCallback);
app.get("/github/link/start", githubLinkStart);
app.post("/github/link/start", githubLinkConfirm);
app.get("/github/link/callback", githubLinkCallback);
app.get("/slack/install", slackInstall);
app.get("/slack/oauth/callback", slackOAuthCallback);
app.post("/slack/events", slackEvents);
app.post("/slack/commands", slackCommands);
app.post("/slack/interactive", slackInteractive);
app.get("/v1/export", exportData);
for (const path of WELL_KNOWN_PATHS) app.get(path, (c) => handleWellKnown(c.req.raw, c.env) ?? c.notFound());
app.put("/v1/logs/:runId/:job", uploadLog);
app.post("/v1/render", renderPreview);
app.get("/v1/agent/sinks", listSinks);
app.post("/v1/agent/sinks", addSink);
app.delete("/v1/agent/sinks/:id", removeSink);
app.post("/v1/agent/sinks/:id/test", testSink);
app.get("/logs/view", viewLogPage);
app.get("/logs/raw", rawLog);
app.get("/logs/stream", streamLog);
app.get("/logs/viewer.css", viewerStylesheet);
app.get("/runs/:runId/logs", logLinks);
app.get("/auth/github/callback", authGithubCallback);
app.get("/logs/viewer.js", viewerScript);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError(handleError);
