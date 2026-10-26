// Every route the hub serves and what authenticates a request to it. The
// forged-request suite attacks each non-public entry; endpoints.test.ts fails
// when a route is added to src/app.ts without an entry here.

export type EndpointAuth =
  /** GitHub's X-Hub-Signature-256 over the body. */
  | "github_sig"
  /** Slack's v0 signature over the timestamp and body. */
  | "slack_sig"
  /** An agent's `hci_agent_` credential, or a pair token on /v1/pair/redeem. */
  | "agent_bearer"
  /** An installation-scoped `hci_mcp_` API token, as an Authorization: Bearer header or the :token path segment. */
  | "api_bearer"
  /** The i, r, j, exp, kid and sig query parameters of a signed log URL. */
  | "log_sig"
  /** A single-use OAuth state, or the browser state cookie it belongs to. */
  | "oauth_state"
  /** A signed session token or cookie the hub issued earlier. */
  | "session"
  /** A single-use token mailed to the address owner. */
  | "email_token"
  /** A signed, browser-bound form token (double-submit cookie) and a same-origin Origin header. */
  | "csrf_form"
  /** A signed session cookie covering the installation, a csrf form token and a same-origin Origin header. */
  | "session_csrf"
  | "public";

export interface Endpoint {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  auth: EndpointAuth;
}

export const ENDPOINTS: Endpoint[] = [
  { method: "GET", path: "/healthz", auth: "public" },
  { method: "GET", path: "/v1/info", auth: "public" },
  { method: "GET", path: "/install", auth: "public" },
  { method: "POST", path: "/github/webhook", auth: "github_sig" },
  { method: "GET", path: "/v1/agent/connect", auth: "agent_bearer" },
  { method: "POST", path: "/v1/pair/redeem", auth: "agent_bearer" },
  { method: "GET", path: "/start", auth: "session" },
  { method: "GET", path: "/start/status", auth: "session" },
  { method: "GET", path: "/github/oauth/callback", auth: "oauth_state" },
  { method: "GET", path: "/github/link/start", auth: "oauth_state" },
  { method: "POST", path: "/github/link/start", auth: "oauth_state" },
  { method: "GET", path: "/github/link/callback", auth: "oauth_state" },
  { method: "GET", path: "/slack/install", auth: "session" },
  { method: "GET", path: "/slack/oauth/callback", auth: "oauth_state" },
  { method: "POST", path: "/slack/events", auth: "slack_sig" },
  { method: "POST", path: "/slack/commands", auth: "slack_sig" },
  { method: "POST", path: "/slack/interactive", auth: "slack_sig" },
  { method: "GET", path: "/v1/export", auth: "session" },
  { method: "GET", path: "/.well-known/security.txt", auth: "public" },
  { method: "GET", path: "/privacy", auth: "public" },
  { method: "GET", path: "/terms", auth: "public" },
  { method: "GET", path: "/support", auth: "public" },
  { method: "GET", path: "/security", auth: "public" },
  { method: "GET", path: "/status", auth: "public" },
  { method: "GET", path: "/assets/inter.woff2", auth: "public" },
  { method: "PUT", path: "/v1/logs/:runId/:job", auth: "agent_bearer" },
  { method: "POST", path: "/v1/render", auth: "agent_bearer" },
  { method: "GET", path: "/v1/agent/sinks", auth: "agent_bearer" },
  { method: "POST", path: "/v1/agent/sinks", auth: "agent_bearer" },
  { method: "DELETE", path: "/v1/agent/sinks/:id", auth: "agent_bearer" },
  { method: "POST", path: "/v1/agent/sinks/:id/test", auth: "agent_bearer" },
  { method: "GET", path: "/logs/view", auth: "log_sig" },
  { method: "GET", path: "/logs/raw", auth: "log_sig" },
  { method: "GET", path: "/logs/stream", auth: "log_sig" },
  { method: "GET", path: "/logs/viewer.css", auth: "public" },
  // The stable log link: a public repo's log opens for anyone; a private repo's needs the hci_session cookie, else it starts sign-in.
  { method: "GET", path: "/runs/:runId/logs", auth: "public" },
  { method: "GET", path: "/auth/github/callback", auth: "oauth_state" },
  { method: "GET", path: "/logs/viewer.js", auth: "public" },
  { method: "GET", path: "/app", auth: "public" },
  { method: "GET", path: "/app/*", auth: "public" },
  { method: "GET", path: "/", auth: "session" },
  { method: "GET", path: "/login", auth: "public" },
  { method: "GET", path: "/:installationId", auth: "session" },
  { method: "GET", path: "/:installationId/runs", auth: "session" },
  { method: "GET", path: "/:installationId/runs/newer", auth: "session" },
  { method: "GET", path: "/:installationId/runs/:runId", auth: "session" },
  { method: "GET", path: "/:installationId/runs/:runId/logs/:job", auth: "session" },
  { method: "GET", path: "/:installationId/runs/:runId/logs/:job/view", auth: "session" },
  { method: "GET", path: "/:installationId/runs/:runId/logs/:job/stream", auth: "session" },
  { method: "GET", path: "/:installationId/runs/:runId/logs/:job/download", auth: "session" },
  { method: "GET", path: "/:installationId/agents", auth: "session" },
  { method: "GET", path: "/:installationId/agents/pair/status", auth: "session" },
  { method: "POST", path: "/:installationId/agents/pair", auth: "session_csrf" },
  { method: "GET", path: "/:installationId/agents/:agentId", auth: "session" },
  { method: "POST", path: "/:installationId/agents/:agentId/revoke", auth: "session_csrf" },
  { method: "POST", path: "/:installationId/agents/:agentId/budget", auth: "session_csrf" },
  { method: "POST", path: "/:installationId/agents/:agentId/bindings/unbind", auth: "session_csrf" },
  { method: "GET", path: "/:installationId/repositories", auth: "session" },
  { method: "GET", path: "/:installationId/repositories/bind", auth: "session" },
  { method: "POST", path: "/:installationId/repositories/bind", auth: "session_csrf" },
  { method: "GET", path: "/:installationId/settings", auth: "session" },
  { method: "POST", path: "/:installationId/runs/:runId/approve", auth: "session_csrf" },
  { method: "POST", path: "/:installationId/runs/:runId/cancel", auth: "session_csrf" },
  { method: "POST", path: "/:installationId/runs/:runId/retry", auth: "session_csrf" },
  { method: "POST", path: "/:installationId/tokens", auth: "session_csrf" },
  { method: "POST", path: "/:installationId/tokens/:tokenId/revoke", auth: "session_csrf" },
  { method: "GET", path: "/account/login", auth: "public" },
  { method: "GET", path: "/account/register", auth: "public" },
  { method: "GET", path: "/account/forgot-password", auth: "public" },
  { method: "GET", path: "/account/google/start", auth: "public" },
  { method: "GET", path: "/account/verify", auth: "email_token" },
  { method: "GET", path: "/account/reset-password", auth: "email_token" },
  { method: "GET", path: "/account/google/callback", auth: "oauth_state" },
  { method: "GET", path: "/account/connect-github", auth: "session" },
  { method: "GET", path: "/account/settings", auth: "session" },
  { method: "GET", path: "/account/delete", auth: "session" },
  { method: "POST", path: "/account/login", auth: "csrf_form" },
  { method: "POST", path: "/account/register", auth: "csrf_form" },
  { method: "POST", path: "/account/forgot-password", auth: "csrf_form" },
  { method: "POST", path: "/account/reset-password", auth: "csrf_form" },
  { method: "POST", path: "/account/connect-github", auth: "csrf_form" },
  { method: "POST", path: "/account/verify", auth: "csrf_form" },
  { method: "POST", path: "/account/logout", auth: "csrf_form" },
  { method: "POST", path: "/account/delete", auth: "csrf_form" },
  { method: "GET", path: "/mcp", auth: "api_bearer" },
  { method: "POST", path: "/mcp", auth: "api_bearer" },
  { method: "DELETE", path: "/mcp", auth: "api_bearer" },
  { method: "GET", path: "/mcp/:token", auth: "api_bearer" },
  { method: "POST", path: "/mcp/:token", auth: "api_bearer" },
  { method: "DELETE", path: "/mcp/:token", auth: "api_bearer" },
];
