// Replay attacks: every single-use proof the hub accepts (GitHub delivery id,
// Slack event id, OAuth state, pair token, fork approval, signed log URL) is
// presented a second time, and the second use must cause no side effect.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hex, hmacSha256 } from "../../src/crypto";
import { approveForkRun } from "../../src/forks/gate";
import type { Installation } from "../../src/github/types";
import worker from "../../src/index";
import { LOG_URL_TTL_SECONDS, signLogUrl } from "../../src/logs/sign";
import { issueState } from "../../src/oauth/state";
import { S } from "../../src/strings";
import { testClock } from "../clock";
import { type CommandWorld, INSTALLATION, LOGIN, REPO, setUpCommandWorld, slackCalls, TEAM, USER } from "../commands-helpers";
import { clearTables } from "../db/helpers";
import pushMain from "../fixtures/github/push.main.json";
import { deliver, type ForkWorld, forkPush, HEAD_SHA, outbox, runs, setUpForkWorld } from "../forks/world";
import { seedTenant } from "../helpers/tenants";
import { gunzip } from "../logs/helpers";

/** Sends req to the worker and waits for its background work. */
async function send(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Rows in from, a table optionally followed by a WHERE clause. */
async function count(from: string): Promise<number> {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${from}`).first<number>("n")) ?? 0;
}

/** The Cookie request header value for a Set-Cookie header. */
function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

function oauthCallback(path: string, query: Record<string, string>, cookie: string): Promise<Response> {
  return send(new Request(`https://hub.test${path}?${new URLSearchParams(query)}`, { headers: { cookie, "cf-connecting-ip": "198.51.100.7" } }));
}

describe("GitHub webhook delivery replay", () => {
  let world: ForkWorld;

  beforeEach(async () => {
    world = await setUpForkWorld();
  });

  afterEach(() => world.restore());

  it("runs a delivery once and answers its replay with 200 duplicate:true", async () => {
    const body = JSON.stringify({
      ...pushMain,
      installation: { ...pushMain.installation, id: INSTALLATION },
      repository: { ...pushMain.repository, id: REPO.repo_id, full_name: REPO.full_name },
    });
    const headers = {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": "replay-delivery-1",
      "x-hub-signature-256": `sha256=${hex(await hmacSha256(env.GITHUB_WEBHOOK_SECRET, body))}`,
    };
    const post = () => send(new Request("https://hub.test/github/webhook", { method: "POST", headers, body }));

    expect((await post()).status).toBe(202);
    const replay = await post();

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ duplicate: true });
    expect(await runs()).toEqual([expect.objectContaining({ repo_id: REPO.repo_id, event: "push" })]);
    expect((await outbox(world.agent)).filter((f) => f.type === "trigger")).toHaveLength(1);
    expect(await count("deliveries")).toBe(1);
  });
});

describe("Slack event replay", () => {
  let world: CommandWorld;

  beforeEach(async () => {
    world = await setUpCommandWorld();
    world.gh.respond("GET", "/orgs/:org/memberships/:login", () => Response.json({ message: "Not Found" }, { status: 404 }));
    world.slack.respond("POST", "/api/views.publish", () => Response.json({ ok: true }));
  });

  afterEach(() => world.restore());

  it("dispatches an event_id delivered twice exactly once", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: TEAM,
      event_id: "EvReplay1",
      event: { type: "app_home_opened", user: USER, tab: "home" },
    });
    const post = async () => {
      const ts = Math.floor(testClock.now() / 1000);
      const headers = {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(ts),
        "x-slack-signature": `v0=${hex(await hmacSha256(env.SLACK_SIGNING_SECRET, `v0:${ts}:${body}`))}`,
      };
      return send(new Request("https://hub.test/slack/events", { method: "POST", headers, body }));
    };

    expect((await post()).status).toBe(200);
    const replay = await post();

    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe("");
    expect(slackCalls(world, "views.publish")).toEqual([expect.objectContaining({ body: expect.objectContaining({ user_id: USER }) })]);
    expect(await count("slack_events")).toBe(1);
  });
});

describe("OAuth state replay", () => {
  let world: CommandWorld;

  beforeEach(async () => {
    world = await setUpCommandWorld();
  });

  afterEach(() => world.restore());

  it("completes a GitHub install callback once and refuses its replay with oauth_state_invalid", async () => {
    const installation: Installation = {
      id: INSTALLATION,
      app_id: Number(env.GITHUB_APP_ID),
      account: { id: 42420, login: "acme", type: "Organization" },
      target_id: 42420,
      target_type: "Organization",
      permissions: { contents: "read", metadata: "read", checks: "write" },
      suspended_at: null,
    };
    world.gh.respond("POST", "/login/oauth/access_token", () => Response.json({ access_token: "ghu_replay", token_type: "bearer", scope: "" }));
    world.gh.respond("GET", "/user/installations", () => Response.json({ total_count: 1, installations: [installation] }));
    world.gh.respond("GET", "/user", () => Response.json({ id: 7001, login: LOGIN }));
    world.gh.respond("GET", "/installation/repositories", () =>
      Response.json({ total_count: 1, repositories: [{ id: REPO.repo_id, full_name: REPO.full_name, default_branch: REPO.default_branch }] }),
    );
    const { state, cookie } = await issueState(env, "github_install", {}, testClock.now());
    const query = { code: "oauth-code", state, setup_action: "install", installation_id: String(INSTALLATION) };

    expect((await oauthCallback("/github/oauth/callback", query, cookiePair(cookie))).status).toBe(200);
    const replay = await oauthCallback("/github/oauth/callback", query, cookiePair(cookie));

    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain(S.pages.errors.oauth_state_invalid);
    expect(world.gh.calls.filter((c) => c.url.endsWith("/login/oauth/access_token"))).toHaveLength(1);
    expect(await count("pair_tokens")).toBe(1);
  });

  it("completes a Slack install callback once and refuses its replay with oauth_state_invalid", async () => {
    world.slack.respond("POST", "/api/oauth.v2.access", () =>
      Response.json({
        ok: true,
        app_id: env.SLACK_APP_ID,
        authed_user: { id: "U0NEWADMIN" },
        scope: "chat:write,commands,channels:read,groups:read,im:write,users:read,users:read.email",
        token_type: "bot",
        access_token: "xoxb-replay-bot-token",
        bot_user_id: "U0NEWBOT",
        team: { id: "T0REPLAY", name: "Replay" },
        enterprise: null,
        is_enterprise_install: false,
      }),
    );
    const payload = { installation_id: INSTALLATION, github_user_id: 7001, github_login: LOGIN };
    const { state, cookie } = await issueState(env, "slack_install", payload, testClock.now());
    const query = { code: "slack-code", state };

    expect((await oauthCallback("/slack/oauth/callback", query, cookiePair(cookie))).status).toBe(200);
    const replay = await oauthCallback("/slack/oauth/callback", query, cookiePair(cookie));

    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain(S.pages.errors.oauth_state_invalid);
    expect(world.slack.calls.filter((c) => c.url === "https://slack.com/api/oauth.v2.access")).toHaveLength(1);
    expect(await count("workspace_links WHERE team_id = 'T0REPLAY'")).toBe(1);
  });
});

describe("pair token replay", () => {
  it("redeems a pair token once and refuses its replay with invalid_pair_token", async () => {
    await clearTables();
    const tenant = await seedTenant(env, { installationId: 31, teamId: "T0PAIR" });
    const redeem = () =>
      send(
        new Request("https://hub.test/v1/pair/redeem", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
          body: JSON.stringify({ pair_token: tenant.pairToken, name: "builder", hostname: "builder.local", agent_version: "1.4.0", os: "linux", arch: "amd64" }),
        }),
      );
    const agentsBefore = await count("agents");

    const first = await redeem();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ credential: expect.stringMatching(/^zc_agent_/), installation_id: tenant.installationId });
    const replay = await redeem();

    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_pair_token" });
    expect(await count("agents")).toBe(agentsBefore + 1);
  });
});

describe("fork approval replay", () => {
  let world: ForkWorld;

  beforeEach(async () => {
    world = await setUpForkWorld();
    await deliver("pull_request", forkPush());
  });

  afterEach(() => world.restore());

  it("dispatches one trigger for an approval and answers its reuse with already_used", async () => {
    const [gated] = await runs();
    expect(gated).toMatchObject({ state: "gated", reason: "fork_gated" });
    const runId = gated?.run_id;
    if (typeof runId !== "string") throw new Error("the fork push stored no gated run");
    const approve = () =>
      approveForkRun(env, {
        installationId: INSTALLATION,
        runId,
        headSha: HEAD_SHA,
        approverGithubId: 7001,
        approverLogin: LOGIN,
        via: "slack",
      });

    expect(await approve()).toBe("dispatched");
    expect(await approve()).toBe("already_used");
    expect(await runs()).toHaveLength(1);
    expect((await outbox(world.agent)).filter((f) => f.type === "trigger")).toHaveLength(1);
  });
});

describe("signed log URL replay", () => {
  it("answers 410 log_expired once the URL is older than its TTL, while a fresh URL still serves the log", async () => {
    await clearTables();
    const tenant = await seedTenant(env, { installationId: 32, teamId: "T0LOGS" });
    const stale = await signLogUrl(env, tenant.runId, tenant.job);
    testClock.advance(LOG_URL_TTL_SECONDS * 1000 + 1);

    const expired = await send(new Request(stale));
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: "log_expired" });

    const fresh = await send(new Request(await signLogUrl(env, tenant.runId, tenant.job)));
    expect(fresh.status).toBe(200);
    expect(await gunzip(await fresh.arrayBuffer())).toBe("tenant 32 secret log\n");
  });
});
