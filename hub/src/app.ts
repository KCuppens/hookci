// The hub's HTTP routes. src/index.ts serves them as the Worker's fetch
// handler; the security suites read app.routes to check every route is covered.

import { type Context, Hono } from "hono";
import type { Env } from "./env";
import { HubError } from "./errors";
import { reportError } from "./observability";
import { accountRoutes } from "./routes/account";
import { agentConnect } from "./routes/agent-connect";
import { dashboardAgent, revokeAgentForm, unbindAgentForm } from "./routes/agent-detail";
import { dashboardAgents, pairAgent, pairStatus } from "./routes/agents";
import { dashboardHome, dashboardLogin, dashboardOverview, dashboardRun, dashboardRunsList, dashboardRunsNewer } from "./routes/dashboard";
import { dashboardLog, dashboardLogDownload, dashboardLogView } from "./routes/dashboard-logs";
import { dashboardRepositories, dashboardSettings } from "./routes/dashboard-tabs";
import { exportData } from "./routes/export";
import { githubLinkCallback, githubLinkConfirm, githubLinkStart } from "./routes/github-link";
import { githubOAuthCallback } from "./routes/github-oauth";
import { githubWebhook } from "./routes/github-webhook";
import { install } from "./routes/install";
import { uploadLog, viewLog } from "./routes/logs";
import { pairRedeem } from "./routes/pair";
import { publicRoutes } from "./routes/public";
import { bindForm, bindSubmit } from "./routes/repository-bind";
import { runApprove, runCancel, runRetry } from "./routes/run-actions";
import { securityTxt } from "./routes/security-txt";
import { slackCommands } from "./routes/slack-commands";
import { slackEvents } from "./routes/slack-events";
import { slackInstall, slackOAuthCallback } from "./routes/slack-install";
import { slackInteractive } from "./routes/slack-interactive";
import { start, startStatus } from "./routes/start";

type AppEnv = { Bindings: Env };

/** Answers HubError with `{"error": code}` and its status; anything else is reported and answered 500. */
export function handleError(err: Error, c: Context<AppEnv>): Response {
	if (err instanceof HubError) return Response.json({ error: err.code }, { status: err.status });
	reportError(err, { method: c.req.method, path: c.req.path });
	return c.json({ error: "internal" }, 500);
}

export const app = new Hono<AppEnv>();

app.get("/healthz", (c) => c.json({ ok: true, version: c.env.HUB_VERSION }));
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
app.route("/account", accountRoutes);
app.get("/slack/install", slackInstall);
app.get("/slack/oauth/callback", slackOAuthCallback);
app.post("/slack/events", slackEvents);
app.post("/slack/commands", slackCommands);
app.post("/slack/interactive", slackInteractive);
app.get("/v1/export", exportData);
app.get("/.well-known/security.txt", securityTxt);
app.route("/", publicRoutes);
app.put("/v1/logs/:runId/:job", uploadLog);
app.get("/logs/:runId/:job", viewLog);
app.get("/app", dashboardHome);
app.get("/app/login", dashboardLogin);
app.get("/app/:installationId", dashboardOverview);
app.get("/app/:installationId/runs", dashboardRunsList);
app.get("/app/:installationId/runs/newer", dashboardRunsNewer);
app.get("/app/:installationId/runs/:runId", dashboardRun);
app.get("/app/:installationId/runs/:runId/logs/:job", dashboardLog);
app.get("/app/:installationId/runs/:runId/logs/:job/view", dashboardLogView);
app.get("/app/:installationId/runs/:runId/logs/:job/download", dashboardLogDownload);
app.get("/app/:installationId/agents", dashboardAgents);
app.get("/app/:installationId/agents/pair/status", pairStatus);
app.post("/app/:installationId/agents/pair", pairAgent);
app.get("/app/:installationId/agents/:agentId", dashboardAgent);
app.post("/app/:installationId/agents/:agentId/revoke", revokeAgentForm);
app.post("/app/:installationId/agents/:agentId/bindings/unbind", unbindAgentForm);
app.get("/app/:installationId/repositories", dashboardRepositories);
app.get("/app/:installationId/settings", dashboardSettings);
app.get("/app/:installationId/repositories/bind", bindForm);
app.post("/app/:installationId/repositories/bind", bindSubmit);
app.post("/app/:installationId/runs/:runId/approve", runApprove);
app.post("/app/:installationId/runs/:runId/cancel", runCancel);
app.post("/app/:installationId/runs/:runId/retry", runRetry);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError(handleError);
