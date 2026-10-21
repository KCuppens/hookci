import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Installation } from "../src/github/types";
import { testClock } from "./clock";
import { clearTables, schemaTables } from "./db/helpers";
import { createFakeGitHub } from "./fakes/github";
import type { FakeService } from "./fakes/http";
import { generateAppKey } from "./github/helpers";

const USER_TOKEN = "ghu_userTokenNeverStored0123456789";
const GITHUB_USER = { id: 7001, login: "octocat" };
const APP_ID = Number(env.GITHUB_APP_ID);
const ACME = 42;
const UMBRELLA = 43;
const REPOS: Record<number, { id: number; full_name: string; default_branch: string }[]> = {
  [ACME]: [
    { id: 1001, full_name: "acme/widgets", default_branch: "main" },
    { id: 1002, full_name: "acme/gadgets", default_branch: "trunk" },
  ],
  [UMBRELLA]: [{ id: 2001, full_name: "umbrella/labs", default_branch: "main" }],
};

function installation(id: number, login: string, appId = APP_ID): Installation {
  return {
    id,
    app_id: appId,
    account: { id: id * 10, login, type: "Organization" },
    target_id: id * 10,
    target_type: "Organization",
    permissions: { contents: "read", metadata: "read", checks: "write" },
    suspended_at: null,
  };
}

let gh: FakeService;
let userInstallations: Installation[];
let appKey: string;
/** Logins GitHub reports as admins of every organization. */
let orgAdmins: Set<string>;
const restore: (() => void)[] = [];

beforeEach(async () => {
  await clearTables();
  appKey ??= (await generateAppKey()).pem;
  gh = createFakeGitHub();
  userInstallations = [installation(ACME, "acme")];
  gh.respond("POST", "/login/oauth/access_token", () => Response.json({ access_token: USER_TOKEN, token_type: "bearer", scope: "" }));
  gh.respond("GET", "/user/installations", ({ headers }) =>
    headers.get("authorization") === `Bearer ${USER_TOKEN}`
      ? Response.json({ total_count: userInstallations.length, installations: userInstallations })
      : Response.json({ message: "Bad credentials" }, { status: 401 }),
  );
  gh.respond("GET", "/user", () => Response.json(GITHUB_USER));
  gh.respond("POST", "/app/installations/:id/access_tokens", ({ params }) =>
    Response.json({ token: `ghs_inst_${params.id}`, expires_at: new Date(testClock.now() + 3_600_000).toISOString() }, { status: 201 }),
  );
  orgAdmins = new Set([GITHUB_USER.login]);
  gh.respond("GET", "/orgs/:org/memberships/:login", ({ params }) =>
    orgAdmins.has(params.login ?? "") ? Response.json({ state: "active", role: "admin" }) : Response.json({ message: "Not Found" }, { status: 404 }),
  );
  gh.respond("GET", "/installation/repositories", ({ headers }) => {
    const id = Number(/^Bearer ghs_inst_(\d+)$/.exec(headers.get("authorization") ?? "")?.[1]);
    const repositories = REPOS[id] ?? [];
    return Response.json({ total_count: repositories.length, repositories });
  });
  const saved = { fetcher: env.__TEST_FETCHER, key: env.GITHUB_APP_PRIVATE_KEY };
  env.__TEST_FETCHER = gh.fetcher;
  env.GITHUB_APP_PRIVATE_KEY = appKey;
  restore.push(() => {
    env.__TEST_FETCHER = saved.fetcher;
    env.GITHUB_APP_PRIVATE_KEY = saved.key;
  });
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  vi.restoreAllMocks();
});

/** The Cookie request header value for a Set-Cookie header. */
function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

/** GET /start, returning the state from the Install button and the state cookie. */
async function beginInstall(): Promise<{ state: string; cookie: string }> {
  const res = await exports.default.fetch("https://hub.test/start");
  expect(res.status).toBe(200);
  const match = /https:\/\/github\.com\/apps\/[^/]+\/installations\/new\?state=([A-Za-z0-9._-]+)"/.exec(await res.text());
  expect(match).not.toBeNull();
  return { state: match?.[1] ?? "", cookie: cookiePair(res.headers.get("set-cookie") ?? "") };
}

function callback(query: Record<string, string>, cookie?: string, ip = "198.51.100.7"): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie !== undefined) headers.cookie = cookie;
  return exports.default.fetch(`https://hub.test/github/oauth/callback?${new URLSearchParams(query)}`, { headers, redirect: "manual" });
}

/** The re-authorization a stateless callback answers with: the state GitHub gets back and the cookie bound to it. */
function reauthorized(res: Response): { state: string; cookie: string } {
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe("https://github.com/login/oauth/authorize");
  const state = location.searchParams.get("state") ?? "";
  expect(Object.fromEntries(location.searchParams)).toEqual({ client_id: env.GITHUB_CLIENT_ID, state, redirect_uri: `${env.HUB_ORIGIN}/github/oauth/callback` });
  const setCookie = res.headers.getSetCookie();
  expect(setCookie).toEqual([expect.stringMatching(/^__Host-hookci_oauth=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/)]);
  return { state, cookie: cookiePair(setCookie[0] ?? "") };
}

/** /start, then the callback GitHub sends after the user installs the app. */
async function install(query: Record<string, string> = {}): Promise<Response> {
  const { state, cookie } = await beginInstall();
  return callback({ code: "oauth-code", state, setup_action: "install", installation_id: String(ACME), ...query }, cookie);
}

/** The session cookie a response sets, as a Cookie header value. */
function sessionCookie(res: Response): string {
  const session = res.headers.getSetCookie().find((c) => c.startsWith("__Host-hookci_session="));
  expect(session).toBeDefined();
  return cookiePair(session ?? "");
}

async function rows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...params).all<T>()).results;
}

describe("GET /start", () => {
  it("links the Install button to the app with a fresh state and sets the __Host- state cookie", async () => {
    const res = await exports.default.fetch("https://hub.test/start");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-hookci_oauth=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
    expect(await res.text()).toContain(`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=`);
    expect(await rows("SELECT kind FROM oauth_states")).toEqual([{ kind: "github_install" }]);
  });
});

describe("GET /github/oauth/callback", () => {
  it("stores the installation and repos and shows a single pair token", async () => {
    const res = await install();
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(await rows("SELECT id, account_login, account_type, permissions, deleted_at FROM installations")).toEqual([
      { id: ACME, account_login: "acme", account_type: "Organization", permissions: JSON.stringify(installation(ACME, "acme").permissions), deleted_at: null },
    ]);
    expect(await rows("SELECT repo_id, full_name, default_branch FROM repos WHERE installation_id = ?1 ORDER BY repo_id", ACME)).toEqual([
      { repo_id: 1001, full_name: "acme/widgets", default_branch: "main" },
      { repo_id: 1002, full_name: "acme/gadgets", default_branch: "trunk" },
    ]);
    expect(await rows("SELECT installation_id, created_by_github_id FROM pair_tokens")).toEqual([
      { installation_id: ACME, created_by_github_id: GITHUB_USER.id },
    ]);
    const token = /sudo hookci connect --hub \S+ (hci_pair_[A-Za-z0-9_-]+)/.exec(html)?.[1];
    expect(token).toBeDefined();
    expect(html).toContain(`curl -fsSL ${env.HUB_ORIGIN}/install | sh -s -- ${token}`);
    expect(html).toContain(`sudo hookci connect --hub ${env.HUB_ORIGIN} ${token}`);
    expect(html).toContain("expires in 15 minutes");
    expect(html).toContain(`/slack/install?installation_id=${ACME}`);
    expect(res.headers.getSetCookie()).toContain("__Host-hookci_oauth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
  });

  it("leaves out the install command while no agent release exists, linking to building the agent", async () => {
    const saved = env.LATEST_AGENT_VERSION;
    env.LATEST_AGENT_VERSION = "";
    restore.push(() => {
      env.LATEST_AGENT_VERSION = saved;
    });
    const html = await (await install()).text();
    expect(html).not.toContain("/install | sh");
    expect(html).toContain('href="https://github.com/KCuppens/hookci#quick-start-local"');
    expect(html).toContain(`sudo hookci connect --hub ${env.HUB_ORIGIN} hci_pair_`);
  });

  it("refuses an installation_id the user cannot access and stores nothing", async () => {
    const res = await install({ installation_id: "999" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Start again");
    expect(await rows("SELECT id FROM installations")).toEqual([]);
    expect(await rows("SELECT token_hash FROM pair_tokens")).toEqual([]);
  });

  it("ignores installations of other apps the user can see", async () => {
    userInstallations = [installation(ACME, "acme", APP_ID + 1)];
    const res = await install();
    expect(res.status).toBe(403);
    expect(await rows("SELECT id FROM installations")).toEqual([]);
  });

  it("never stores or logs the GitHub user token", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const res = await install();
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(USER_TOKEN);

    for (const table of await schemaTables()) {
      expect(JSON.stringify(await rows(`SELECT * FROM ${table}`))).not.toContain(USER_TOKEN);
    }
    const output = JSON.stringify(logged);
    expect(output).toContain("github_install");
    expect(output).not.toContain(USER_TOKEN);
  });

  it("rejects a replayed state", async () => {
    const { state, cookie } = await beginInstall();
    const query = { code: "oauth-code", state, setup_action: "install", installation_id: String(ACME) };
    expect((await callback(query, cookie)).status).toBe(200);
    const replay = await callback(query, cookie);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("Start again");
    expect(await rows("SELECT token_hash FROM pair_tokens")).toHaveLength(1);
  });

  it("re-authorizes a GitHub-initiated install under a fresh state and never uses the code it came with", async () => {
    const { cookie: started } = await beginInstall();
    for (const cookie of [started, undefined]) {
      const { state, cookie: bound } = reauthorized(await callback({ code: "attacker-code", setup_action: "install", installation_id: String(ACME) }, cookie));
      expect(gh.calls).toEqual([]);
      expect(await rows("SELECT id FROM installations")).toEqual([]);

      const res = await callback({ code: "oauth-code", state }, bound);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("hci_pair_");
      expect(await rows("SELECT installation_id FROM pair_tokens")).toEqual([{ installation_id: ACME }]);
      await clearTables();
      gh.calls.length = 0;
    }
  });

  it("refuses a callback with neither our state nor GitHub's install redirect", async () => {
    const queries: Record<string, string>[] = [{ code: "oauth-code" }, { code: "oauth-code", setup_action: "request", installation_id: String(ACME) }];
    for (const query of queries) {
      const res = await callback(query);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(gh.calls).toEqual([]);
  });

  it("returns 429 for the 21st callback from one IP within 10 minutes", async () => {
    testClock.advance(600_000 - (testClock.now() % 600_000));
    for (let i = 1; i <= 20; i++) expect((await callback({ code: "x" })).status).toBe(400);
    expect((await callback({ code: "x" })).status).toBe(429);
    expect((await callback({ code: "x" }, undefined, "198.51.100.8")).status).toBe(400);
  });

  it("renders the permissions-updated page for setup_action=update without a pair token", async () => {
    const { state, cookie } = reauthorized(await callback({ code: "oauth-code", setup_action: "update", installation_id: String(ACME) }));
    const res = await callback({ code: "oauth-code", state }, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Permissions updated");
    expect(html).not.toContain("hci_pair_");
    expect(await rows("SELECT token_hash FROM pair_tokens")).toEqual([]);
    expect(await rows("SELECT id FROM installations")).toEqual([{ id: ACME }]);
  });

  it("escapes HTML in the account login", async () => {
    userInstallations = [installation(ACME, `<script>alert(1)</script>&"'`)];
    const html = await (await install()).text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;");
    expect(html).not.toContain("<script>alert(1)");
  });

  it("lists several installations, then pairs the one picked through /start", async () => {
    userInstallations = [installation(ACME, "acme"), installation(UMBRELLA, "umbrella")];
    const { state, cookie } = await beginInstall();
    const picker = await callback({ code: "oauth-code", state, setup_action: "install" }, cookie);
    expect(picker.status).toBe(200);
    const html = await picker.text();
    expect(html).toContain(`/start?installation_id=${ACME}`);
    expect(html).toContain(`/start?installation_id=${UMBRELLA}`);
    expect(await rows("SELECT token_hash FROM pair_tokens")).toEqual([]);
    expect(await rows("SELECT repo_id FROM repos ORDER BY repo_id")).toEqual([{ repo_id: 1001 }, { repo_id: 1002 }, { repo_id: 2001 }]);

    expect((await exports.default.fetch(`https://hub.test/start?installation_id=${UMBRELLA}`)).status).toBe(403);
    const session = sessionCookie(picker);
    const picked = await exports.default.fetch(`https://hub.test/start?installation_id=${UMBRELLA}`, { headers: { cookie: session } });
    expect(picked.status).toBe(200);
    expect(await picked.text()).toContain(`sudo hookci connect --hub ${env.HUB_ORIGIN} hci_pair_`);
    expect(await rows("SELECT installation_id, created_by_github_id FROM pair_tokens")).toEqual([
      { installation_id: UMBRELLA, created_by_github_id: GITHUB_USER.id },
    ]);
  });

  it("shows a member who is not an org admin the install without a pair token, here or through /start", async () => {
    orgAdmins.clear();
    const res = await install();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Only an admin of acme");
    expect(html).not.toContain("hci_pair_");
    expect(html).not.toContain("/slack/install");

    const picked = await exports.default.fetch(`https://hub.test/start?installation_id=${ACME}`, { headers: { cookie: sessionCookie(res) } });
    expect(picked.status).toBe(200);
    expect(await picked.text()).not.toContain("hci_pair_");
    expect(await rows("SELECT token_hash FROM pair_tokens")).toEqual([]);
  });
});

describe("GET /start/status", () => {
  it("answers only the session's browser and counts online agents", async () => {
    const session = sessionCookie(await install());
    const status = (cookie?: string) =>
      exports.default.fetch(`https://hub.test/start/status?installation_id=${ACME}`, cookie ? { headers: { cookie } } : {});

    expect((await status()).status).toBe(404);
    const before = await status(session);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ installed: true, agents_online: 0, slack_linked: false });

    await env.DB.prepare(
      `INSERT INTO agents (agent_id, installation_id, name, credential_hash, paired_by_github_id, paired_at, status)
       VALUES ('agt_status', ?1, 'builder', 'hash-status', ?2, ?3, 'online')`,
    )
      .bind(ACME, GITHUB_USER.id, testClock.now())
      .run();
    expect(await (await status(session)).json()).toEqual({ installed: true, agents_online: 1, slack_linked: false });
  });
});
