// Every non-public endpoint attacked with forged credentials: missing,
// wrong, made with a secret that was rotated out, a stale Slack timestamp and
// a bearer of the wrong kind. Each answer must carry the endpoint's exact
// refusal code, and the only D1 table a refused request may write is ip_rate.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base64url, hex, hmacSha256 } from "../../src/crypto";
import { agentCredentialHash, getAgentByCredentialHash } from "../../src/db/agents";
import { verifyGithubSignature } from "../../src/github/verify";
import worker from "../../src/index";
import { verifyLogUrl } from "../../src/logs/signing";
import { escapeHtml } from "../../src/pages/layout";
import { rotateCredential } from "../../src/pairing/agents";
import { authenticateAgent } from "../../src/routes/agent-auth";
import { verifySlackRequest } from "../../src/slack/verify";
import { S } from "../../src/strings";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { countingD1 } from "../helpers/d1-counter";
import { seedTenant, type Tenant } from "../helpers/tenants";
import { gzip } from "../logs/helpers";
import { type Endpoint, type EndpointAuth, ENDPOINTS } from "./endpoints";

const ORIGIN = "https://hub.test";
const INSTALLATION = 701;
const TEAM = "T0FORGED";
const ROTATED_SECRET = "rotated-secret-the-attacker-never-saw";
const WRONG_SECRET = "attacker-made-this-up";
const STALE_SECONDS = 301;

const original = {
  GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET,
  GITHUB_WEBHOOK_SECRET_PREVIOUS: env.GITHUB_WEBHOOK_SECRET_PREVIOUS,
  SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
  SLACK_SIGNING_SECRET_PREVIOUS: env.SLACK_SIGNING_SECRET_PREVIOUS,
  LOG_SIGNING_KEY_PREVIOUS: env.LOG_SIGNING_KEY_PREVIOUS,
  DB: env.DB,
};

type CaseKind = "missing" | "wrong" | "previous" | "stale" | "wrong_bearer";

type Expected =
  /** A JSON `{error}` body. */
  | { status: number; json: string }
  /** An HTML errorPage, which shows the message S.pages.errors holds for the code. */
  | { status: number; page: "oauth_state_invalid" | "github_no_access" }
  /** /slack/install's start-from-GitHub page, which carries no error code and issues no state. */
  | { status: 403; slackStartPage: true }
  /** The log viewer's link-expired page, which says to open the run again for a fresh link. */
  | { status: 403; logLinkPage: true };

interface Case {
  kind: CaseKind;
  name: string;
  /** Builds the request; anything it writes to D1 happens before counting starts. */
  request: (tenant: Tenant) => Promise<Request>;
  expected: Expected;
}

/** Every auth class's cases open with a missing and a wrong case; the compiler enforces it. */
type CaseList = [Case & { kind: "missing" }, Case & { kind: "wrong" }, ...Case[]];

const nowSeconds = (): number => Math.floor(testClock.now() / 1000);

function webhookRequest(body: string, signature: string | null): Request {
  const headers = new Headers({ "content-type": "application/json", "x-github-event": "push", "x-github-delivery": crypto.randomUUID() });
  if (signature !== null) headers.set("x-hub-signature-256", signature);
  return new Request(`${ORIGIN}/github/webhook`, { method: "POST", headers, body });
}

const pushBody = (tenant: Tenant): string =>
  JSON.stringify({
    ref: "refs/heads/main",
    after: tenant.headSha,
    installation: { id: tenant.installationId },
    repository: { id: tenant.repoId, full_name: tenant.fullName, default_branch: "main" },
  });

/** A valid-looking body for each Slack endpoint, aimed at the seeded workspace. */
const SLACK_BODIES: Record<string, { contentType: string; body: (tenant: Tenant) => string }> = {
  "/slack/events": {
    contentType: "application/json",
    body: (t) =>
      JSON.stringify({
        type: "event_callback",
        team_id: t.teamId,
        event_id: `Ev${crypto.randomUUID()}`,
        event: { type: "app_home_opened", user: t.slackUserId, tab: "home" },
      }),
  },
  "/slack/commands": {
    contentType: "application/x-www-form-urlencoded",
    body: (t) =>
      new URLSearchParams({
        team_id: t.teamId,
        user_id: t.slackUserId,
        channel_id: t.channelId,
        command: "/hookci",
        text: `watch ${t.fullName}`,
        response_url: "https://hooks.slack.com/commands/forged",
        trigger_id: "trg.forged",
      }).toString(),
  },
  "/slack/interactive": {
    contentType: "application/x-www-form-urlencoded",
    body: (t) =>
      new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: t.teamId },
          user: { id: t.slackUserId, team_id: t.teamId },
          channel: { id: t.channelId },
          message: { ts: `${t.installationId}.0001` },
          response_url: "https://hooks.slack.com/actions/forged",
          actions: [{ action_id: "fork:approve", value: `${t.runId}:${t.headSha}` }],
        }),
      }).toString(),
  },
};

function slackBodyFor(path: string): { contentType: string; body: (tenant: Tenant) => string } {
  const spec = SLACK_BODIES[path];
  if (!spec) throw new Error(`no Slack body for ${path}`);
  return spec;
}

async function slackRequest(path: string, contentType: string, body: string, signing: { ts: number; secret: string } | null): Promise<Request> {
  const headers = new Headers({ "content-type": contentType });
  if (signing) {
    headers.set("x-slack-request-timestamp", String(signing.ts));
    headers.set("x-slack-signature", `v0=${hex(await hmacSha256(signing.secret, `v0:${signing.ts}:${body}`))}`);
  }
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body });
}

/** A request to an agent bearer route (connect, log upload, render or sink config) carrying authorization. */
async function bearerRequest(method: string, path: string, tenant: Tenant, authorization: string | null): Promise<Request> {
  const headers = new Headers({ "cf-connecting-ip": "203.0.113.7" });
  if (authorization !== null) headers.set("authorization", authorization);
  if (path === "/v1/agent/connect") {
    headers.set("upgrade", "websocket");
    return new Request(`${ORIGIN}${path}`, { headers });
  }
  if (path === "/v1/logs/:runId/:job") {
    const log = await gzip("forged log\n");
    headers.set("content-encoding", "gzip");
    headers.set("x-hookci-log-bytes", "11");
    headers.set("x-hookci-log-truncated", "0");
    return new Request(`${ORIGIN}/v1/logs/${tenant.runId}/${tenant.job}`, { method: "PUT", headers, body: log });
  }
  if (path === "/v1/render") {
    headers.set("content-type", "application/json");
    const body = { v: 1, kind: "deploy_badge", repo: tenant.fullName, env: "staging", sha: tenant.headSha, state: "running" };
    return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  }
  if (path === "/v1/agent/sinks" && method === "GET") {
    return new Request(`${ORIGIN}${path}?repo=${tenant.fullName}`, { headers });
  }
  if (path === "/v1/agent/sinks") {
    headers.set("content-type", "application/json");
    const body = { kind: "webhook", repo: tenant.fullName, url: "https://example.com/hookci" };
    return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  }
  if (path === "/v1/agent/sinks/:id") return new Request(`${ORIGIN}/v1/agent/sinks/snk_forged`, { method: "DELETE", headers });
  if (path === "/v1/agent/sinks/:id/test") return new Request(`${ORIGIN}/v1/agent/sinks/snk_forged/test`, { method: "POST", headers });
  throw new Error(`no bearer request for ${method} ${path}`);
}

function redeemRequest(pairToken: string | undefined): Request {
  const fields = { name: "laptop", hostname: "laptop.local", agent_version: "0.3.0", os: "linux", arch: "amd64" };
  return new Request(`${ORIGIN}/v1/pair/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify(pairToken === undefined ? fields : { ...fields, pair_token: pairToken }),
  });
}

/** A state of the right shape, signed with a key that is not STATE_SIGNING_KEY, and the cookie that binds it. */
async function forgedState(kind: string): Promise<{ state: string; cookie: string }> {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { state: `${nonce}.${base64url(await hmacSha256(WRONG_SECRET, `${kind}.${nonce}`))}`, cookie: `__Host-hookci_oauth=${nonce}` };
}

/** Each OAuth route's state parameter, and the state kind the route checks; POST /github/link/start takes the same form field. */
const OAUTH_ROUTES: Record<string, { param: string; kind: string }> = {
  "/github/oauth/callback": { param: "state", kind: "github_install" },
  "/github/link/start": { param: "t", kind: "github_link" },
  "/github/link/callback": { param: "state", kind: "github_link" },
  "/slack/oauth/callback": { param: "state", kind: "slack_install" },
  "/auth/github/callback": { param: "state", kind: "github_logs" },
};

/** A GET with fields in the query, or a POST with them as a form body. */
function oauthRequest(method: string, path: string, fields: Record<string, string>, cookie: string | null): Request {
  const headers = new Headers({ "cf-connecting-ip": "203.0.113.7" });
  if (cookie !== null) headers.set("cookie", cookie);
  const encoded = new URLSearchParams(fields).toString();
  if (method === "POST") {
    headers.set("content-type", "application/x-www-form-urlencoded");
    return new Request(`${ORIGIN}${path}`, { method, headers, body: encoded });
  }
  return new Request(`${ORIGIN}${path}?${encoded}`, { headers });
}

/** A session cookie for the tenant with a signature made under a key the hub does not hold. */
async function forgedSession(tenant: Tenant): Promise<string> {
  const body = `${tenant.installationId}.${tenant.githubUserId}.${tenant.githubLogin}.${testClock.now() + 30 * 60_000}`;
  return `__Host-hookci_session=${body}.${base64url(await hmacSha256(WRONG_SECRET, `session.${body}`))}`;
}

function sessionRequest(path: string, tenant: Tenant, cookie: string | null): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}?installation_id=${tenant.installationId}`, { headers });
}

const SESSION_REFUSALS: Record<string, Expected> = {
  "/start": { status: 403, page: "github_no_access" },
  "/start/status": { status: 404, json: "not_found" },
  "/slack/install": { status: 403, slackStartPage: true },
};

function sessionRefusal(path: string): Expected {
  const expected = SESSION_REFUSALS[path];
  if (!expected) throw new Error(`no session refusal for ${path}`);
  return expected;
}

/** The forged requests each auth class gets. */
const CASES: Record<Exclude<EndpointAuth, "public">, (endpoint: Endpoint) => CaseList> = {
  github_sig: () => [
    { kind: "missing", name: "no X-Hub-Signature-256", request: async (t) => webhookRequest(pushBody(t), null), expected: { status: 401, json: "bad_signature" } },
    {
      kind: "wrong",
      name: "signed with a secret the hub never had",
      request: async (t) => webhookRequest(pushBody(t), `sha256=${hex(await hmacSha256(WRONG_SECRET, pushBody(t)))}`),
      expected: { status: 401, json: "bad_signature" },
    },
    {
      kind: "previous",
      name: "signed with the previous secret after it was removed",
      request: async (t) => {
        const body = pushBody(t);
        const signature = `sha256=${hex(await hmacSha256(original.GITHUB_WEBHOOK_SECRET, body))}`;
        expect(await verifyGithubSignature(await new Response(body).arrayBuffer(), signature, [original.GITHUB_WEBHOOK_SECRET])).toBe(true);
        env.GITHUB_WEBHOOK_SECRET = ROTATED_SECRET;
        delete env.GITHUB_WEBHOOK_SECRET_PREVIOUS;
        return webhookRequest(body, signature);
      },
      expected: { status: 401, json: "bad_signature" },
    },
  ],

  slack_sig: ({ path }) => {
    const { contentType, body } = slackBodyFor(path);
    return [
      {
        kind: "missing",
        name: "no X-Slack-Signature or timestamp",
        request: (t) => slackRequest(path, contentType, body(t), null),
        expected: { status: 401, json: "slack_bad_signature" },
      },
      {
        kind: "wrong",
        name: "signed with a secret the hub never had",
        request: (t) => slackRequest(path, contentType, body(t), { ts: nowSeconds(), secret: WRONG_SECRET }),
        expected: { status: 401, json: "slack_bad_signature" },
      },
      {
        kind: "previous",
        name: "signed with the previous secret after it was removed",
        request: async (t) => {
          const req = await slackRequest(path, contentType, body(t), { ts: nowSeconds(), secret: original.SLACK_SIGNING_SECRET });
          const raw = new TextDecoder().decode(await req.clone().arrayBuffer());
          await verifySlackRequest(raw, req.headers, [original.SLACK_SIGNING_SECRET], testClock.now());
          env.SLACK_SIGNING_SECRET = ROTATED_SECRET;
          delete env.SLACK_SIGNING_SECRET_PREVIOUS;
          return req;
        },
        expected: { status: 401, json: "slack_bad_signature" },
      },
      {
        kind: "stale",
        name: `correctly signed ${STALE_SECONDS} s ago`,
        request: (t) => slackRequest(path, contentType, body(t), { ts: nowSeconds() - STALE_SECONDS, secret: original.SLACK_SIGNING_SECRET }),
        expected: { status: 401, json: "slack_stale" },
      },
    ];
  },

  agent_bearer: ({ method, path }) => {
    if (path === "/v1/pair/redeem") {
      return [
        { kind: "missing", name: "no pair_token", request: async () => redeemRequest(undefined), expected: { status: 400, json: "bad_request" } },
        {
          kind: "wrong",
          name: "a pair token the hub never issued",
          request: async () => redeemRequest(`hci_pair_${crypto.randomUUID().replaceAll("-", "")}`),
          expected: { status: 400, json: "invalid_pair_token" },
        },
        {
          kind: "wrong_bearer",
          name: "an agent credential in place of the pair token",
          request: async (t) => redeemRequest(t.credential),
          expected: { status: 400, json: "invalid_pair_token" },
        },
      ];
    }
    return [
      { kind: "missing", name: "no Authorization", request: (t) => bearerRequest(method, path, t, null), expected: { status: 401, json: "auth_failed" } },
      {
        kind: "wrong",
        name: "an agent credential the hub never issued",
        request: (t) => bearerRequest(method, path, t, `Bearer hci_agent_${crypto.randomUUID().replaceAll("-", "")}`),
        expected: { status: 401, json: "auth_failed" },
      },
      {
        kind: "wrong_bearer",
        name: "the tenant's pair token as the bearer",
        request: (t) => bearerRequest(method, path, t, `Bearer ${t.pairToken}`),
        expected: { status: 401, json: "auth_failed" },
      },
      {
        kind: "wrong_bearer",
        name: "the agent credential under the Basic scheme",
        request: (t) => bearerRequest(method, path, t, `Basic ${t.credential}`),
        expected: { status: 401, json: "auth_failed" },
      },
      {
        kind: "previous",
        name: "the credential a re-pair replaced, once the new one was used",
        request: async (t) => {
          expect(await getAgentByCredentialHash(env.DB, await agentCredentialHash(t.credential))).toMatchObject({ agent_id: t.agentId });
          const next = await rotateCredential(env, t.agentId);
          expect(await authenticateAgent(env, `Bearer ${next}`)).toMatchObject({ agent_id: t.agentId });
          return bearerRequest(method, path, t, `Bearer ${t.credential}`);
        },
        expected: { status: 401, json: "auth_failed" },
      },
    ];
  },

  log_sig: ({ path }) => {
    /** A link to the tenant's job log with kid and a signature over the v1 message made with secret. */
    const logRequest = async (t: Tenant, secret: string, kid: "c" | "p"): Promise<Request> => {
      const exp = String(nowSeconds() + 600);
      const i = String(t.installationId);
      const sig = base64url(await hmacSha256(secret, `v1\n${i}\n${t.runId}\n${t.job}\n${exp}`));
      return new Request(`${ORIGIN}${path}?${new URLSearchParams({ i, r: t.runId, j: t.job, exp, kid, sig })}`);
    };
    return [
      {
        kind: "missing",
        name: "no exp, kid or sig",
        request: async (t) => new Request(`${ORIGIN}${path}?${new URLSearchParams({ i: String(t.installationId), r: t.runId, j: t.job })}`),
        expected: { status: 403, logLinkPage: true },
      },
      {
        kind: "wrong",
        name: "signed with a key the hub never had",
        request: async (t) => logRequest(t, WRONG_SECRET, "c"),
        expected: { status: 403, logLinkPage: true },
      },
      {
        kind: "previous",
        name: "signed with the previous key once LOG_SIGNING_KEY_PREVIOUS is removed",
        request: async (t) => {
          env.LOG_SIGNING_KEY_PREVIOUS = ROTATED_SECRET;
          const req = await logRequest(t, ROTATED_SECRET, "p");
          expect(await verifyLogUrl(env, new URL(req.url).searchParams, new Date(testClock.now()))).toMatchObject({ ok: true });
          delete env.LOG_SIGNING_KEY_PREVIOUS;
          return req;
        },
        expected: { status: 403, logLinkPage: true },
      },
    ];
  },

  oauth_state: ({ method, path }) => {
    const route = OAUTH_ROUTES[path];
    if (!route) throw new Error(`no OAuth route for ${path}`);
    return [
      {
        kind: "missing",
        name: "no state",
        request: async () => oauthRequest(method, path, path === "/github/link/start" ? {} : { code: "forged-code" }, null),
        expected: { status: 400, page: "oauth_state_invalid" },
      },
      {
        kind: "wrong",
        name: "a state signed with a key the hub never had, with its cookie",
        request: async () => {
          const { state, cookie } = await forgedState(route.kind);
          return oauthRequest(method, path, { code: "forged-code", [route.param]: state }, cookie);
        },
        expected: { status: 400, page: "oauth_state_invalid" },
      },
    ];
  },

  session: ({ path }) => {
    if (path === "/v1/export") {
      return [
        { kind: "missing", name: "no token", request: async () => new Request(`${ORIGIN}/v1/export`), expected: { status: 403, json: "export_token_invalid" } },
        {
          kind: "wrong",
          name: "a token signed with a key the hub never had",
          request: async (t) => {
            const data = `${t.teamId}.${t.slackUserId}.${testClock.now() + 600_000}`;
            const token = `${data}.${base64url(await hmacSha256(WRONG_SECRET, data))}`;
            return new Request(`${ORIGIN}/v1/export?token=${encodeURIComponent(token)}`);
          },
          expected: { status: 403, json: "export_token_invalid" },
        },
      ];
    }
    const expected = sessionRefusal(path);
    return [
      { kind: "missing", name: "no session cookie", request: async (t) => sessionRequest(path, t, null), expected },
      { kind: "wrong", name: "a session cookie signed with a key the hub never had", request: async (t) => sessionRequest(path, t, await forgedSession(t)), expected },
    ];
  },
};

function casesFor(endpoint: Endpoint): Case[] {
  if (endpoint.auth === "public") return [];
  return CASES[endpoint.auth](endpoint);
}

const ATTACKED = ENDPOINTS.filter((e) => e.auth !== "public");

let tenant: Tenant;

beforeEach(async () => {
  await clearTables();
  tenant = await seedTenant(env, { installationId: INSTALLATION, teamId: TEAM });
});

afterEach(() => {
  env.DB = original.DB;
  env.GITHUB_WEBHOOK_SECRET = original.GITHUB_WEBHOOK_SECRET;
  env.SLACK_SIGNING_SECRET = original.SLACK_SIGNING_SECRET;
  if (original.LOG_SIGNING_KEY_PREVIOUS === undefined) delete env.LOG_SIGNING_KEY_PREVIOUS;
  else env.LOG_SIGNING_KEY_PREVIOUS = original.LOG_SIGNING_KEY_PREVIOUS;
  if (original.GITHUB_WEBHOOK_SECRET_PREVIOUS === undefined) delete env.GITHUB_WEBHOOK_SECRET_PREVIOUS;
  else env.GITHUB_WEBHOOK_SECRET_PREVIOUS = original.GITHUB_WEBHOOK_SECRET_PREVIOUS;
  if (original.SLACK_SIGNING_SECRET_PREVIOUS === undefined) delete env.SLACK_SIGNING_SECRET_PREVIOUS;
  else env.SLACK_SIGNING_SECRET_PREVIOUS = original.SLACK_SIGNING_SECRET_PREVIOUS;
});

describe.each(ATTACKED)("$method $path ($auth)", (endpoint) => {
  it.each(casesFor(endpoint))("refuses $kind: $name", async ({ request, expected }) => {
    const req = await request(tenant);
    const counter = countingD1(env.DB);
    env.DB = counter.db;

    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(expected.status);
    if ("json" in expected) {
      expect(await res.json()).toEqual({ error: expected.json });
    } else if ("page" in expected) {
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain(escapeHtml(S.pages.errors[expected.page]));
    } else if ("logLinkPage" in expected) {
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain(escapeHtml(S.logViewer.linkExpired));
    } else {
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.text()).toContain(escapeHtml(S.pages.slackStartBody));
    }
    expect(Object.keys(counter.byTable()).filter((table) => table !== "ip_rate")).toEqual([]);
  });
});
