// Every route the hub serves and what authenticates a request to it. The
// forged-request suite attacks each non-public entry; endpoints.test.ts fails
// when a route is added to src/app.ts without an entry here.

export type EndpointAuth =
  /** GitHub's X-Hub-Signature-256 over the body. */
  | "github_sig"
  /** Slack's v0 signature over the timestamp and body. */
  | "slack_sig"
  /** An agent's `zc_agent_` credential, or a pair token on /v1/pair/redeem. */
  | "agent_bearer"
  /** The exp and sig query parameters of a signed log URL. */
  | "log_sig"
  /** A single-use OAuth state, or the browser state cookie it belongs to. */
  | "oauth_state"
  /** A signed session token or cookie the hub issued earlier. */
  | "session"
  /** A single-use token mailed to the address owner. */
  | "email_token"
  /** A signed, browser-bound form token (double-submit cookie) and a same-origin Origin header. */
  | "csrf_form"
  | "public";

export interface Endpoint {
  method: "GET" | "POST" | "PUT";
  path: string;
  auth: EndpointAuth;
}

export const ENDPOINTS: Endpoint[] = [
  { method: "GET", path: "/healthz", auth: "public" },
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
  { method: "PUT", path: "/v1/logs/:runId/:job", auth: "agent_bearer" },
  { method: "GET", path: "/logs/:runId/:job", auth: "log_sig" },
  { method: "GET", path: "/app", auth: "session" },
  { method: "GET", path: "/app/login", auth: "public" },
  { method: "GET", path: "/app/:installationId", auth: "session" },
  { method: "GET", path: "/app/:installationId/runs/:runId", auth: "session" },
  { method: "GET", path: "/app/:installationId/runs/:runId/logs/:job", auth: "session" },
  { method: "GET", path: "/account/login", auth: "public" },
  { method: "GET", path: "/account/register", auth: "public" },
  { method: "GET", path: "/account/forgot-password", auth: "public" },
  { method: "GET", path: "/account/google/start", auth: "public" },
  { method: "GET", path: "/account/verify", auth: "email_token" },
  { method: "GET", path: "/account/reset-password", auth: "email_token" },
  { method: "GET", path: "/account/google/callback", auth: "oauth_state" },
  { method: "GET", path: "/account/connect-github", auth: "session" },
  { method: "POST", path: "/account/login", auth: "csrf_form" },
  { method: "POST", path: "/account/register", auth: "csrf_form" },
  { method: "POST", path: "/account/forgot-password", auth: "csrf_form" },
  { method: "POST", path: "/account/reset-password", auth: "csrf_form" },
  { method: "POST", path: "/account/connect-github", auth: "csrf_form" },
];
