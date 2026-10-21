import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertInstallation } from "../src/db/installations";
import { getWorkspace, setWorkspaceStatus } from "../src/db/workspaces";
import type { Fetcher } from "../src/http";
import { issueSession } from "../src/oauth/state";
import { escapeHtml } from "../src/pages/layout";
import { exchangeSlackCode, revokeSlackToken } from "../src/slack/oauth";
import { S } from "../src/strings";
import { getBotToken } from "../src/slack/tokens";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { createFakeGitHub, serveInstallationTokens } from "./fakes/github";
import type { FakeService } from "./fakes/http";
import { createFakeSlack } from "./fakes/slack";
import { generateAppKey } from "./github/helpers";

const ACME = 42;
const OTHER = 43;
const GITHUB_USER = { id: 7001, login: "octocat" };
const TEAM = "T0ACME";
const ADMIN = "U0ADMIN";
const BOT_TOKEN = "xoxb-1111-2222-acmeBotTokenSecret";
const SCOPES = "chat:write,commands,channels:read,groups:read,im:write,users:read,users:read.email";

let slack: FakeService;
let grant: Record<string, unknown>;
let revokedWith: (string | null)[];
/** Logins GitHub reports as admins of every organization. */
let orgAdmins: Set<string>;
let appKey: string;
const restore: (() => void)[] = [];

function oauthAccess(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    app_id: env.SLACK_APP_ID,
    authed_user: { id: ADMIN },
    scope: SCOPES,
    token_type: "bot",
    access_token: BOT_TOKEN,
    bot_user_id: "U0BOT",
    team: { id: TEAM, name: "Acme & Co" },
    enterprise: null,
    is_enterprise_install: false,
    ...overrides,
  };
}

beforeEach(async () => {
  await clearTables();
  await upsertInstallation(env.DB, { id: ACME, account_login: "acme", account_type: "Organization", account_id: ACME * 10, created_at: 1 });
  slack = createFakeSlack();
  grant = oauthAccess();
  revokedWith = [];
  slack.respond("POST", "/api/oauth.v2.access", () => Response.json(grant));
  slack.respond("POST", "/api/auth.revoke", ({ headers }) => {
    revokedWith.push(headers.get("authorization"));
    return Response.json({ ok: true, revoked: true });
  });
  orgAdmins = new Set([GITHUB_USER.login]);
  const gh = createFakeGitHub();
  serveInstallationTokens(gh, testClock.now());
  gh.respond("GET", "/orgs/:org/memberships/:login", ({ params }) =>
    orgAdmins.has(params.login ?? "") ? Response.json({ state: "active", role: "admin" }) : Response.json({ message: "Not Found" }, { status: 404 }),
  );
  appKey ??= (await generateAppKey()).pem;
  const saved = { fetcher: env.__TEST_FETCHER, key: env.GITHUB_APP_PRIVATE_KEY };
  env.GITHUB_APP_PRIVATE_KEY = appKey;
  env.__TEST_FETCHER = (input, init) =>
    (new URL(input instanceof Request ? input.url : String(input)).host === "slack.com" ? slack : gh).fetcher(input, init);
  restore.push(() => {
    env.__TEST_FETCHER = saved.fetcher;
    env.GITHUB_APP_PRIVATE_KEY = saved.key;
  });
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

/** The Cookie request header value for a Set-Cookie header. */
function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

async function sessionCookie(installationIds = [ACME]): Promise<string> {
  return cookiePair(await issueSession(env, { installationIds, githubUserId: GITHUB_USER.id, githubLogin: GITHUB_USER.login }, testClock.now()));
}

function slackInstall(cookie?: string, installationId = ACME): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  return exports.default.fetch(`https://hub.test/slack/install?installation_id=${installationId}`, { headers, redirect: "manual" });
}

function callback(query: Record<string, string>, cookie?: string, ip = "198.51.100.7"): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie !== undefined) headers.cookie = cookie;
  return exports.default.fetch(`https://hub.test/slack/oauth/callback?${new URLSearchParams(query)}`, { headers });
}

/** /slack/install with a session, returning the state from the Slack URL and the state cookie. */
async function beginSlackInstall(): Promise<{ state: string; cookie: string }> {
  const res = await slackInstall(await sessionCookie());
  expect(res.status).toBe(302);
  const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
  expect(state).not.toBeNull();
  return { state: state ?? "", cookie: cookiePair(res.headers.get("set-cookie") ?? "") };
}

/** The whole browser flow: /slack/install, then the callback Slack sends after consent. */
async function install(): Promise<Response> {
  const { state, cookie } = await beginSlackInstall();
  return callback({ code: "slack-code", state }, cookie);
}

async function rows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...params).all<T>()).results;
}

async function storedNothing(): Promise<void> {
  expect(await rows("SELECT team_id FROM workspaces")).toEqual([]);
  expect(await rows("SELECT team_id FROM workspace_links")).toEqual([]);
  expect(await rows("SELECT team_id FROM user_links")).toEqual([]);
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe("GET /slack/install", () => {
  it("redirects to Slack OAuth v2 with exactly the bot scopes and a fresh slack_install state", async () => {
    const res = await slackInstall(await sessionCookie());
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-hookci_oauth=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://slack.com/oauth/v2/authorize?")).toBe(true);
    expect(location).toContain(`scope=${SCOPES}&`);
    expect(location).not.toContain("user_scope");
    expect(location).not.toContain("chat:write.public");
    const url = new URL(location);
    expect(url.searchParams.get("client_id")).toBe(env.SLACK_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`${env.HUB_ORIGIN}/slack/oauth/callback`);
    expect(await rows("SELECT kind, payload FROM oauth_states")).toEqual([
      { kind: "slack_install", payload: JSON.stringify({ installation_id: ACME, github_user_id: GITHUB_USER.id, github_login: GITHUB_USER.login }) },
    ]);
  });

  it("shows the start-from-GitHub page without a session cookie, or with one for another installation", async () => {
    for (const res of [await slackInstall(), await slackInstall(await sessionCookie([OTHER]))]) {
      expect(res.status).toBe(403);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("set-cookie")).toBeNull();
      const html = await res.text();
      expect(html).toContain(S.pages.slackStartTitle);
      expect(html).toContain('href="/start"');
      expect(html).not.toContain("slack.com");
    }
    expect(await rows("SELECT kind FROM oauth_states")).toEqual([]);
  });

  it("shows the start-from-GitHub page for a deleted installation", async () => {
    await env.DB.prepare("UPDATE installations SET deleted_at = 1 WHERE id = ?1").bind(ACME).run();
    const res = await slackInstall(await sessionCookie());
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(S.pages.slackStartTitle);
  });

  it("refuses a session holder who is not an admin of the installation's account, issuing no state", async () => {
    orgAdmins.clear();
    const res = await slackInstall(await sessionCookie());
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain(escapeHtml(S.pages.errors.installation_admin_required));
    expect(await rows("SELECT kind FROM oauth_states")).toEqual([]);
  });
});

describe("GET /slack/oauth/callback", () => {
  it("stores the encrypted bot token, links the workspace and the installing admin", async () => {
    const res = await install();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-hookci_oauth=; .*Max-Age=0$/);
    const html = await res.text();
    expect(html).toContain("HookCI is in Acme &amp; Co.");
    expect(html).toContain("Next: invite @hookci to a channel and run <code>/hookci watch &lt;owner/repo&gt;</code>");
    expect(html).toContain(`href="slack://app?team=${TEAM}&amp;id=${env.SLACK_APP_ID}&amp;tab=home"`);

    expect(slack.calls).toEqual([
      {
        method: "POST",
        url: "https://slack.com/api/oauth.v2.access",
        body: {
          client_id: env.SLACK_CLIENT_ID,
          client_secret: env.SLACK_CLIENT_SECRET,
          code: "slack-code",
          redirect_uri: `${env.HUB_ORIGIN}/slack/oauth/callback`,
        },
      },
    ]);

    const workspace = await getWorkspace(env.DB, TEAM);
    expect(workspace).toMatchObject({ team_name: "Acme & Co", bot_user_id: "U0BOT", key_version: 1, installed_by: ADMIN, status: "active" });
    const ct = workspace?.bot_token_ct ?? new Uint8Array();
    expect(ct.byteLength).toBeGreaterThan(BOT_TOKEN.length);
    expect(containsBytes(ct, new TextEncoder().encode(BOT_TOKEN))).toBe(false);
    expect(containsBytes(ct, new TextEncoder().encode("xoxb-"))).toBe(false);
    expect(await getBotToken(env, TEAM)).toBe(BOT_TOKEN);

    expect(await rows("SELECT team_id, installation_id, linked_by FROM workspace_links")).toEqual([
      { team_id: TEAM, installation_id: ACME, linked_by: ADMIN },
    ]);
    expect(await rows("SELECT team_id, slack_user_id, github_user_id, github_login FROM user_links")).toEqual([
      { team_id: TEAM, slack_user_id: ADMIN, github_user_id: GITHUB_USER.id, github_login: GITHUB_USER.login },
    ]);
  });

  it("links one workspace to a second installation without touching the first link", async () => {
    await upsertInstallation(env.DB, { id: OTHER, account_login: "other", account_type: "Organization", account_id: OTHER * 10, created_at: 1 });
    expect((await install()).status).toBe(200);
    const res = await slackInstall(await sessionCookie([OTHER]), OTHER);
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
    expect((await callback({ code: "slack-code", state }, cookiePair(res.headers.get("set-cookie") ?? ""))).status).toBe(200);
    expect(await rows("SELECT installation_id FROM workspace_links WHERE team_id = ?1 ORDER BY installation_id", TEAM)).toEqual([
      { installation_id: ACME },
      { installation_id: OTHER },
    ]);
  });

  it.each([
    ["is_enterprise_install", { is_enterprise_install: true, team: null, enterprise: { id: "E0GRID", name: "Grid" } }],
    ["an enterprise id", { enterprise: { id: "E0GRID", name: "Grid" } }],
  ])("refuses Enterprise Grid (%s): stores nothing and revokes the token", async (_name, overrides) => {
    grant = oauthAccess(overrides);
    const res = await install();
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain(S.pages.slackGridTitle);
    expect(html).not.toContain(BOT_TOKEN);
    expect(slack.calls.map((c) => c.url)).toEqual(["https://slack.com/api/oauth.v2.access", "https://slack.com/api/auth.revoke"]);
    expect(revokedWith).toEqual([`Bearer ${BOT_TOKEN}`]);
    await storedNothing();
  });

  it("still refuses Enterprise Grid when auth.revoke fails", async () => {
    grant = oauthAccess({ enterprise: { id: "E0GRID", name: "Grid" } });
    slack.respond("POST", "/api/auth.revoke", () => Response.json({ ok: false, error: "invalid_auth" }));
    const res = await install();
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(S.pages.slackGridTitle);
    await storedNothing();
  });

  it.each([
    ["missing im:write", SCOPES.replace("im:write,", "")],
    ["with chat:write.public", `${SCOPES},chat:write.public`],
  ])("answers 400 slack_scope_mismatch for a grant %s and stores nothing", async (_name, scope) => {
    grant = oauthAccess({ scope });
    const res = await install();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(S.pages.errors.slack_scope_mismatch);
    await storedNothing();
  });

  it("reactivates an uninstalled workspace on reinstall and replaces the token ciphertext", async () => {
    expect((await install()).status).toBe(200);
    const before = await getWorkspace(env.DB, TEAM);
    await setWorkspaceStatus(env.DB, TEAM, "uninstalled");

    const newToken = "xoxb-3333-4444-acmeReinstalledToken";
    grant = oauthAccess({ access_token: newToken, team: { id: TEAM, name: "Acme Renamed" } });
    expect((await install()).status).toBe(200);

    const after = await getWorkspace(env.DB, TEAM);
    expect(after).toMatchObject({ team_name: "Acme Renamed", status: "active", created_at: before?.created_at });
    expect(after?.bot_token_ct).not.toEqual(before?.bot_token_ct);
    expect(await getBotToken(env, TEAM)).toBe(newToken);
    expect(await rows("SELECT team_id FROM workspace_links")).toEqual([{ team_id: TEAM }]);
  });

  it("rejects a replayed state and a callback without state", async () => {
    const { state, cookie } = await beginSlackInstall();
    expect((await callback({ code: "slack-code", state }, cookie)).status).toBe(200);
    for (const res of [await callback({ code: "slack-code", state }, cookie), await callback({ code: "slack-code" }, cookie)]) {
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(S.pages.errors.oauth_state_invalid);
    }
  });

  it("shows slack_oauth_failed when the user cancels or Slack rejects the code", async () => {
    const cancelled = await beginSlackInstall();
    const res = await callback({ error: "access_denied", state: cancelled.state }, cancelled.cookie);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(S.pages.errors.slack_oauth_failed);

    grant = { ok: false, error: "invalid_code" };
    const rejected = await install();
    expect(rejected.status).toBe(502);
    expect(await rejected.text()).toContain(S.pages.errors.slack_oauth_failed);
    await storedNothing();
  });

  it("shows slack_oauth_failed when Slack does not answer the code exchange in time", async () => {
    slack.respond("POST", "/api/oauth.v2.access", () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const res = await install();
    expect(res.status).toBe(502);
    expect(await res.text()).toContain(S.pages.errors.slack_oauth_failed);
    await storedNothing();
  });

  it("returns 429 for the 21st callback from one IP within 10 minutes", async () => {
    testClock.advance(600_000 - (testClock.now() % 600_000));
    for (let i = 1; i <= 20; i++) expect((await callback({ code: "x" })).status).toBe(400);
    expect((await callback({ code: "x" })).status).toBe(429);
    expect((await callback({ code: "x" }, undefined, "198.51.100.8")).status).toBe(400);
  });
});

describe("Slack OAuth calls", () => {
  it("give the code exchange and the revoke a timeout, and refuse a call that runs out", async () => {
    const signals: unknown[] = [];
    const late: Fetcher = async (_input, init) => {
      signals.push(init?.signal);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    await expect(exchangeSlackCode(env, late, "slack-code")).rejects.toMatchObject({ code: "slack_oauth_failed", status: 502 });
    await expect(revokeSlackToken(late, BOT_TOKEN)).rejects.toMatchObject({ code: "slack_revoke_failed", status: 502 });
    expect(signals).toEqual([expect.any(AbortSignal), expect.any(AbortSignal)]);
  });
});

describe("getBotToken", () => {
  it("throws workspace_inactive for a revoked workspace and workspace_not_found for an unknown team", async () => {
    expect((await install()).status).toBe(200);
    await setWorkspaceStatus(env.DB, TEAM, "revoked");
    await expect(getBotToken(env, TEAM)).rejects.toMatchObject({ code: "workspace_inactive", status: 410 });
    await expect(getBotToken(env, "T0NONE")).rejects.toMatchObject({ code: "workspace_not_found", status: 404 });
  });
});
