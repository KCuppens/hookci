import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { encryptToken, hex, hmacSha256, parseEncKeys } from "../src/crypto";
import { upsertInstallation } from "../src/db/installations";
import { upsertRepos } from "../src/db/repos";
import { tenantDb } from "../src/db/tenant";
import { linkWorkspace, upsertUserLink, upsertWorkspace } from "../src/db/workspaces";
import { resetPermissionCacheForTests } from "../src/github/permission-cache";
import worker from "../src/index";
import { workspaceAad } from "../src/slack/tokens";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { createFakeGitHub } from "./fakes/github";
import type { FakeCall, FakeService } from "./fakes/http";
import { createFakeSlack } from "./fakes/slack";
import { generateAppKey } from "./github/helpers";

export const TEAM = "T0ACME";
export const USER = "U0USER";
export const CHANNEL = "C0CHAN";
export const INSTALLATION = 4242;
export const OTHER_INSTALLATION = 5151;
export const REPO = { repo_id: 900, full_name: "acme/api", default_branch: "main" };
export const LOGIN = "octocat";
const RESPONSE_URL = "https://hooks.slack.com/commands/T0ACME/1/abc";
const PERMISSION_PATH = "/repos/:owner/:repo/collaborators/:login/permission";

let appKey: string | undefined;

export interface CommandWorld {
  gh: FakeService;
  slack: FakeService;
  /** GitHub role per login (lowercase) the fake permission endpoint answers; absent logins get 404. */
  roles: Record<string, string>;
  /** Undoes the env changes; call from afterEach. */
  restore(): void;
}

/**
 * Blank database with workspace TEAM (real encrypted bot token) linked to
 * INSTALLATION, which owns REPO; USER linked to GitHub LOGIN. Fakes route
 * hooks.slack.com and slack.com to the Slack fake and everything else to the
 * GitHub fake, which mints installation tokens and answers role lookups.
 */
export async function setUpCommandWorld(): Promise<CommandWorld> {
  await clearTables();
  resetPermissionCacheForTests();
  const now = testClock.now();
  const { ct, keyVersion } = await encryptToken(parseEncKeys(env.TOKEN_ENC_KEYS), "xoxb-test", workspaceAad(TEAM));
  await upsertWorkspace(env.DB, {
    team_id: TEAM,
    team_name: "Acme",
    bot_user_id: "U0BOT",
    bot_token_ct: ct,
    key_version: keyVersion,
    installed_by: "U0ADMIN",
    status: "active",
    created_at: 1,
  });
  for (const id of [INSTALLATION, OTHER_INSTALLATION]) {
    await upsertInstallation(env.DB, { id, account_login: `acct${id}`, account_type: "Organization", account_id: id * 10, created_at: 1 });
  }
  await linkWorkspace(tenantDb(env.DB, INSTALLATION), TEAM, "U0ADMIN", 1);
  await upsertRepos(tenantDb(env.DB, INSTALLATION), [REPO]);
  await upsertUserLink(env.DB, { team_id: TEAM, slack_user_id: USER, github_user_id: 7001, github_login: LOGIN, created_at: 1 });

  appKey ??= (await generateAppKey()).pem;
  const roles: Record<string, string> = {};
  const gh = createFakeGitHub();
  gh.respond("POST", "/app/installations/:id/access_tokens", () =>
    Response.json({ token: "ghs_command", expires_at: new Date(now + 86_400_000).toISOString() }, { status: 201 }),
  );
  gh.respond("GET", PERMISSION_PATH, ({ params }) => {
    const role = roles[(params.login ?? "").toLowerCase()];
    return role ? Response.json({ permission: role, role_name: role }) : Response.json({ message: "Not Found" }, { status: 404 });
  });
  const slack = createFakeSlack();
  slack.respond("POST", /^\/commands\//, () => new Response("ok"));
  const saved = { fetcher: env.__TEST_FETCHER, key: env.GITHUB_APP_PRIVATE_KEY };
  env.GITHUB_APP_PRIVATE_KEY = appKey;
  env.__TEST_FETCHER = (input, init) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    return (host === "hooks.slack.com" || host === "slack.com" ? slack : gh).fetcher(input, init);
  };
  return {
    gh,
    slack,
    roles,
    restore() {
      env.__TEST_FETCHER = saved.fetcher;
      env.GITHUB_APP_PRIVATE_KEY = saved.key;
    },
  };
}

/** Runs `/hookci <text>` as userId in CHANNEL and returns the reply SlackWorkspaceDO posted to response_url. */
export async function hookci(world: CommandWorld, text: string, userId = USER): Promise<{ text: string; blocks?: unknown[] }> {
  const body = new URLSearchParams({
    team_id: TEAM,
    user_id: userId,
    channel_id: CHANNEL,
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
  const before = world.slack.calls.filter((c) => c.url === RESPONSE_URL).length;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://hub.test/slack/commands", { method: "POST", headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  const posts = world.slack.calls.filter((c) => c.url === RESPONSE_URL);
  expect(posts.length).toBe(before + 1);
  const reply = posts.at(-1)?.body;
  expect(reply).toMatchObject({ response_type: "ephemeral", text: expect.any(String) });
  // The fake parsed the JSON body; the toMatchObject above checked its shape.
  const checked = reply as { text: string; blocks?: unknown[] };
  return checked;
}

/** Slack Web API calls the fake recorded for method, as `chat.postMessage`. */
export function slackCalls(world: CommandWorld, method: string): FakeCall[] {
  return world.slack.calls.filter((c) => c.url === `https://slack.com/api/${method}`);
}

/** Commands never read channel history: no conversations.history or conversations.replies call in the Slack fake's log. */
export function expectNoHistoryReads(world: CommandWorld): void {
  const reads = world.slack.calls.filter((c) => /\/api\/conversations\.(history|replies)$/.test(new URL(c.url).pathname));
  expect(reads).toEqual([]);
}

/** Permission lookups the GitHub fake answered for login. */
export function permissionCalls(world: CommandWorld, login = LOGIN): FakeCall[] {
  return world.gh.calls.filter((c) => c.method === "GET" && new URL(c.url).pathname.endsWith(`/collaborators/${login}/permission`));
}
