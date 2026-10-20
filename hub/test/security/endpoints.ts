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
  /** The i, r, j, exp, kid and sig query parameters of a signed log URL. */
  | "log_sig"
  /** A single-use OAuth state, or the browser state cookie it belongs to. */
  | "oauth_state"
  /** A signed session token or cookie the hub issued earlier. */
  | "session"
  | "public";

export interface Endpoint {
  method: "GET" | "POST" | "PUT";
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
  { method: "PUT", path: "/v1/logs/:runId/:job", auth: "agent_bearer" },
  { method: "POST", path: "/v1/render", auth: "agent_bearer" },
  { method: "GET", path: "/logs/view", auth: "log_sig" },
  { method: "GET", path: "/logs/raw", auth: "log_sig" },
  { method: "GET", path: "/logs/viewer.css", auth: "public" },
  // The stable log link: a public repo's log opens for anyone; a private repo's needs the zc_session cookie, else it starts sign-in.
  { method: "GET", path: "/runs/:runId/logs", auth: "public" },
  { method: "GET", path: "/auth/github/callback", auth: "oauth_state" },
];
