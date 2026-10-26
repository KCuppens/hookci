// The hub's HTTP routes. src/index.ts serves them as the Worker's fetch
// handler; the security suites read app.routes to check every route is covered.

import { type Context, Hono } from "hono";
import { systemClock } from "./do/clock";
import type { Env } from "./env";
import { HubError } from "./errors";
import { mcpRoute, mcpRouteWithToken } from "./mcp/server";
import { renewSession, SESSION_COOKIE } from "./oauth/state";
import { reportError } from "./observability";
import { accountRoutes } from "./routes/account";
import { agentConnect } from "./routes/agent-connect";
import { dashboardAgent, revokeAgentForm, setAgentBudgetForm, unbindAgentForm } from "./routes/agent-detail";
import { dashboardAgents, pairAgent, pairStatus } from "./routes/agents";
import { createApiTokenForm, revokeApiTokenForm } from "./routes/api-tokens";
import { dashboardHome, dashboardLogin, dashboardOverview, dashboardRun, dashboardRunsList, dashboardRunsNewer } from "./routes/dashboard";
import { dashboardLog, dashboardLogDownload, dashboardLogView } from "./routes/dashboard-logs";
import { dashboardRepositories, dashboardSettings } from "./routes/dashboard-tabs";
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
import { publicRoutes } from "./routes/public";
import { renderPreview } from "./routes/render";
import { bindForm, bindSubmit } from "./routes/repository-bind";
import { runApprove, runCancel, runRetry } from "./routes/run-actions";
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

/** Background polls repeat without anyone using the page, so they must not keep a session alive. */
const POLL_PATH = /^\/app\/\d+\/(?:runs\/newer|agents\/pair\/status)$/;

/** Keeps an active person signed in: any dashboard or account request with a valid session restarts its idle window. */
app.use("*", async (c, next) => {
	await next();
	if (!c.req.path.startsWith("/app") && !c.req.path.startsWith("/account")) return;
	if (POLL_PATH.test(c.req.path)) return;
	if (c.res.headers.getSetCookie().some((v) => v.startsWith(`${SESSION_COOKIE}=`))) return;
	const renewed = await renewSession(c.env, c.req.header("cookie"), (c.env.__TEST_CLOCK ?? systemClock).now());
	if (renewed !== null) c.header("Set-Cookie", renewed, { append: true });
});

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
app.route("/account", accountRoutes);
app.get("/slack/install", slackInstall);
app.get("/slack/oauth/callback", slackOAuthCallback);
app.post("/slack/events", slackEvents);
app.post("/slack/commands", slackCommands);
app.post("/slack/interactive", slackInteractive);
app.get("/v1/export", exportData);
app.get("/mcp", mcpRoute);
app.post("/mcp", mcpRoute);
app.delete("/mcp", mcpRoute);
app.get("/mcp/:token", mcpRouteWithToken);
app.post("/mcp/:token", mcpRouteWithToken);
app.delete("/mcp/:token", mcpRouteWithToken);
for (const path of WELL_KNOWN_PATHS) app.get(path, (c) => handleWellKnown(c.req.raw, c.env) ?? c.notFound());
app.route("/", publicRoutes);
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
app.post("/app/:installationId/agents/:agentId/budget", setAgentBudgetForm);
app.post("/app/:installationId/agents/:agentId/bindings/unbind", unbindAgentForm);
app.get("/app/:installationId/repositories", dashboardRepositories);
app.get("/app/:installationId/settings", dashboardSettings);
app.post("/app/:installationId/tokens", createApiTokenForm);
app.post("/app/:installationId/tokens/:tokenId/revoke", revokeApiTokenForm);
app.get("/app/:installationId/repositories/bind", bindForm);
app.post("/app/:installationId/repositories/bind", bindSubmit);
app.post("/app/:installationId/runs/:runId/approve", runApprove);
app.post("/app/:installationId/runs/:runId/cancel", runCancel);
app.post("/app/:installationId/runs/:runId/retry", runRetry);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError(handleError);
