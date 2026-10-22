import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex, hmacSha256 } from "../src/crypto";
import { upsertWorkspace } from "../src/db/workspaces";
import { HubError } from "../src/errors";
import { requireLinkedUser } from "../src/identity/link";
import worker from "../src/index";
import { registerCommand } from "../src/slack/registry";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { clearTables, schemaTables } from "./db/helpers";
import { createFakeGitHub } from "./fakes/github";
import type { FakeService } from "./fakes/http";
import { createFakeSlack } from "./fakes/slack";

const TEAM = "T0ACME";
const USER = "U0USER";
const RESPONSE_URL = "https://hooks.slack.com/commands/T0ACME/1/abc";
const USER_TOKEN = "ghu_userTokenNeverStored0123456789";
const TOKEN_PATH = `/applications/${env.GITHUB_CLIENT_ID}/token`;

let gh: FakeService;
let slack: FakeService;
let githubUser: { id: number; login: string };
let revokeAuth: (string | null)[];
const restore: (() => void)[] = [];

beforeEach(async () => {
  await clearTables();
  await upsertWorkspace(env.DB, {
    team_id: TEAM,
    team_name: "Acme",
    bot_user_id: "U0BOT",
    bot_token_ct: new Uint8Array([1]),
    key_version: 1,
    installed_by: "U0ADMIN",
    status: "active",
    created_at: 1,
  });
  githubUser = { id: 7001, login: "octocat" };
  revokeAuth = [];
  gh = createFakeGitHub();
  gh.respond("POST", "/login/oauth/access_token", () => Response.json({ access_token: USER_TOKEN, token_type: "bearer", scope: "" }));
  gh.respond("GET", "/user", ({ headers }) =>
    headers.get("authorization") === `Bearer ${USER_TOKEN}` ? Response.json(githubUser) : Response.json({ message: "Bad credentials" }, { status: 401 }),
  );
  gh.respond("DELETE", TOKEN_PATH, ({ headers }) => {
    revokeAuth.push(headers.get("authorization"));
    return new Response(null, { status: 204 });
  });
  slack = createFakeSlack();
  slack.respond("POST", /^\/commands\//, () => new Response("ok"));
  const saved = env.__TEST_FETCHER;
  env.__TEST_FETCHER = (input, init) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    return (host === "hooks.slack.com" ? slack : gh).fetcher(input, init);
  };
  restore.push(() => {
    env.__TEST_FETCHER = saved;
  });
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  vi.restoreAllMocks();
});

/** Runs `/hookci <text>` as USER and returns the reply SlackWorkspaceDO posted to response_url. */
async function hookci(text: string): Promise<unknown> {
  const body = new URLSearchParams({
    team_id: TEAM,
    user_id: USER,
    channel_id: "C0CHAN",
    command: "/hookci",
    text,
    response_url: RESPONSE_URL,
    trigger_id: "1.2.trig",
  }).toString();
  const ts = Math.floor(testClock.now() / 1000);
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${hex(await hmacSha256(env.SLACK_SIGNING_SECRET, `v0:${ts}:${body}`))}`,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://hub.test/slack/commands", { method: "POST", headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  const posts = slack.calls.filter((c) => c.url === RESPONSE_URL);
  expect(posts.length).toBeGreaterThan(0);
  return posts.at(-1)?.body;
}

/** The URL of the Link button in a `/hookci me` reply. */
function linkButtonUrl(reply: unknown): string {
  expect(reply).toMatchObject({
    blocks: expect.arrayContaining([{ type: "actions", elements: [expect.objectContaining({ type: "button", text: expect.objectContaining({ text: S.slack.linkButton }) })] }]),
  });
  const url = /"url":"([^"]+)"/.exec(JSON.stringify(reply))?.[1];
  expect(url).toBeDefined();
  return url ?? "";
}

function get(url: string, cookie?: string, ip = "198.51.100.7"): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie !== undefined) headers.cookie = cookie;
  return exports.default.fetch(url, { headers, redirect: "manual" });
}

/** POSTs the confirmation page's form for state t, as the page's button does. */
function confirm(t: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7", "content-type": "application/x-www-form-urlencoded" };
  if (cookie !== undefined) headers.cookie = cookie;
  return exports.default.fetch(`${env.HUB_ORIGIN}/github/link/start`, {
    method: "POST",
    headers,
    body: new URLSearchParams({ t }).toString(),
    redirect: "manual",
  });
}

/** The name=value part of the response's state cookie. */
function stateCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/^__Host-hookci_oauth=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  return setCookie.split(";")[0] ?? "";
}

/** Opens the Link button URL and confirms on the page; returns the state GitHub gets and the cookie the browser keeps. */
async function startLink(url: string): Promise<{ state: string; cookie: string }> {
  const shown = await get(url);
  expect(shown.status).toBe(200);
  const res = await confirm(new URL(url).searchParams.get("t") ?? "", stateCookie(shown));
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get("location") ?? "");
  return { state: location.searchParams.get("state") ?? "", cookie: stateCookie(res) };
}

function callback(state: string, cookie: string): Promise<Response> {
  return get(`${env.HUB_ORIGIN}/github/link/callback?${new URLSearchParams({ code: "oauth-code", state })}`, cookie);
}

/** `/hookci me`, the Link button, then GitHub's redirect back. */
async function link(): Promise<Response> {
  const { state, cookie } = await startLink(linkButtonUrl(await hookci("me")));
  return callback(state, cookie);
}

async function userLinks(): Promise<unknown[]> {
  return (await env.DB.prepare("SELECT team_id, slack_user_id, github_user_id, github_login FROM user_links ORDER BY team_id, slack_user_id").all()).results;
}

function revokeCalls(): unknown[] {
  return gh.calls.filter((c) => c.method === "DELETE" && new URL(c.url).pathname === TOKEN_PATH).map((c) => c.body);
}

describe("/hookci me", () => {
  it("offers an unlinked user an ephemeral Link button to /github/link/start", async () => {
    const reply = await hookci("me");
    expect(reply).toMatchObject({ response_type: "ephemeral", text: S.slack.linkPrompt });
    expect(linkButtonUrl(reply).startsWith(`${env.HUB_ORIGIN}/github/link/start?t=`)).toBe(true);
    expect(await env.DB.prepare("SELECT kind FROM oauth_states").all()).toMatchObject({ results: [{ kind: "github_link" }] });
  });

  it("tells a linked user their login, and unlink removes only their link", async () => {
    await env.DB.prepare(
      "INSERT INTO user_links (team_id, slack_user_id, github_user_id, github_login, created_at) VALUES (?1, 'U0OTHER', 8002, 'hubot', 1)",
    )
      .bind(TEAM)
      .run();
    expect((await link()).status).toBe(200);
    expect(await hookci("me")).toEqual({ response_type: "ephemeral", text: S.slack.linkedAs("octocat") });

    expect(await hookci("me unlink")).toEqual({ response_type: "ephemeral", text: S.slack.unlinked("octocat") });
    expect(await userLinks()).toEqual([{ team_id: TEAM, slack_user_id: "U0OTHER", github_user_id: 8002, github_login: "hubot" }]);
    expect(await hookci("me unlink")).toEqual({ response_type: "ephemeral", text: S.slack.notLinkedNothing });
  });
});

describe("/github/link/start", () => {
  it("names the Slack workspace and user on a page, and goes to GitHub only from that page's POST", async () => {
    const url = linkButtonUrl(await hookci("me"));
    const t = new URL(url).searchParams.get("t") ?? "";
    const shown = await get(url);
    expect(shown.status).toBe(200);
    const html = await shown.text();
    expect(html).toContain(S.flow.link.title);
    expect(html).toContain("Acme");
    expect(html).toContain(USER);
    expect(html).toContain(`<form method="post" action="/github/link/start"><input type="hidden" name="t" value="${t}">`);
    const mark = stateCookie(shown);
    expect(mark).not.toBe(`__Host-hookci_oauth=${t.split(".")[0]}`);
    expect((await get(url)).status).toBe(200);

    const res = await confirm(t, mark);
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: env.GITHUB_CLIENT_ID,
      state: t,
      redirect_uri: `${env.HUB_ORIGIN}/github/link/callback`,
    });
    expect(stateCookie(res)).toBe(`__Host-hookci_oauth=${t.split(".")[0]}`);
  });

  it("refuses a POST that lacks the page's cookie, as from a form on another site", async () => {
    const url = linkButtonUrl(await hookci("me"));
    const t = new URL(url).searchParams.get("t") ?? "";
    const other = stateCookie(await get(linkButtonUrl(await hookci("me"))));
    stateCookie(await get(url));
    for (const cookie of [undefined, other, `__Host-hookci_oauth=${t.split(".")[0]}`]) {
      const res = await confirm(t, cookie);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("does not finish a link with only the page's cookie, skipping the POST", async () => {
    const url = linkButtonUrl(await hookci("me"));
    const mark = stateCookie(await get(url));
    expect((await callback(new URL(url).searchParams.get("t") ?? "", mark)).status).toBe(400);
    expect(await userLinks()).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("refuses an unknown, expired or used state", async () => {
    expect((await get(`${env.HUB_ORIGIN}/github/link/start?t=forged.state`)).status).toBe(400);
    const url = linkButtonUrl(await hookci("me"));
    const mark = stateCookie(await get(url));
    testClock.advance(10 * 60 * 1000 + 1);
    expect((await get(url)).status).toBe(400);
    expect((await confirm(new URL(url).searchParams.get("t") ?? "", mark)).status).toBe(400);
  });

  it("returns 429 for the 21st request from one IP within 10 minutes", async () => {
    testClock.advance(600_000 - (testClock.now() % 600_000));
    const url = `${env.HUB_ORIGIN}/github/link/start?t=forged.state`;
    for (let i = 1; i <= 20; i++) expect((await get(url)).status).toBe(400);
    expect((await get(url)).status).toBe(429);
    expect((await confirm("forged.state")).status).toBe(429);
    expect((await get(url, undefined, "198.51.100.8")).status).toBe(400);
  });
});

describe("GET /github/link/callback", () => {
  it("links the Slack user to the GitHub user and revokes the user token once", async () => {
    const res = await link();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(S.flow.link.doneTitle("octocat"));
    expect(res.headers.getSetCookie()).toContain("__Host-hookci_oauth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
    expect(await userLinks()).toEqual([{ team_id: TEAM, slack_user_id: USER, github_user_id: 7001, github_login: "octocat" }]);
    expect(revokeCalls()).toEqual([{ access_token: USER_TOKEN }]);
    expect(revokeAuth).toEqual([`Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`]);
  });

  it("replaces the old link when a second link from before completes", async () => {
    const first = await startLink(linkButtonUrl(await hookci("me")));
    const second = await startLink(linkButtonUrl(await hookci("me")));
    expect((await callback(first.state, first.cookie)).status).toBe(200);
    githubUser = { id: 7002, login: "monalisa" };
    expect((await callback(second.state, second.cookie)).status).toBe(200);
    expect(await userLinks()).toEqual([{ team_id: TEAM, slack_user_id: USER, github_user_id: 7002, github_login: "monalisa" }]);
  });

  it("rejects a replayed callback and leaves the link as it was", async () => {
    const { state, cookie } = await startLink(linkButtonUrl(await hookci("me")));
    expect((await callback(state, cookie)).status).toBe(200);
    githubUser = { id: 7002, login: "monalisa" };
    const replay = await callback(state, cookie);
    expect(replay.status).toBe(400);
    expect(await userLinks()).toEqual([{ team_id: TEAM, slack_user_id: USER, github_user_id: 7001, github_login: "octocat" }]);
    expect(revokeCalls()).toHaveLength(1);
  });

  it("rejects a cookie holding another state's nonce", async () => {
    const first = await startLink(linkButtonUrl(await hookci("me")));
    const second = await startLink(linkButtonUrl(await hookci("me")));
    expect((await callback(first.state, second.cookie)).status).toBe(400);
    expect(await userLinks()).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("still links when GitHub fails to revoke the token, and reports the failure", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    gh.respond("DELETE", TOKEN_PATH, () => Response.json({ message: "Validation Failed" }, { status: 422 }));
    const res = await link();
    expect(res.status).toBe(200);
    expect(await userLinks()).toHaveLength(1);
    expect(JSON.stringify(errors.mock.calls)).toContain("github_link_revoke");
  });

  it("treats a token GitHub no longer knows (404) as revoked", async () => {
    const errors = vi.spyOn(console, "error");
    gh.respond("DELETE", TOKEN_PATH, () => Response.json({ message: "Not Found" }, { status: 404 }));
    expect((await link()).status).toBe(200);
    expect(await userLinks()).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("never stores or logs the GitHub user token", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const res = await link();
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(USER_TOKEN);
    for (const table of await schemaTables()) {
      expect(JSON.stringify((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results)).not.toContain(USER_TOKEN);
    }
    const output = JSON.stringify(logged);
    expect(output).toContain("github_link");
    expect(output).not.toContain(USER_TOKEN);
  });
});

describe("requireLinkedUser", () => {
  it("throws not_linked before linking and returns the GitHub identity after", async () => {
    const before = requireLinkedUser(env, TEAM, USER);
    await expect(before).rejects.toBeInstanceOf(HubError);
    await expect(before).rejects.toMatchObject({ code: "not_linked", status: 403 });
    await link();
    expect(await requireLinkedUser(env, TEAM, USER)).toEqual({ githubUserId: 7001, githubLogin: "octocat" });
    await expect(requireLinkedUser(env, "T0OTHER", USER)).rejects.toMatchObject({ code: "not_linked" });
    await hookci("me unlink");
    await expect(requireLinkedUser(env, TEAM, USER)).rejects.toMatchObject({ code: "not_linked" });
  });

  it("turns not_linked from a command into the /hookci me prompt instead of a failure", async () => {
    const errors = vi.spyOn(console, "error");
    registerCommand("probe", async ({ env: e, teamId, userId }) => {
      const user = await requireLinkedUser(e, teamId, userId);
      return { text: user.githubLogin };
    });
    expect(await hookci("probe")).toEqual({ response_type: "ephemeral", text: S.slack.notLinked });
    expect(errors).not.toHaveBeenCalled();
    await link();
    expect(await hookci("probe")).toEqual({ text: "octocat" });
  });
});
