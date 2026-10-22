import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Installation } from "../src/github/types";
import { readAnySession, SESSION_COOKIE } from "../src/oauth/state";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { createFakeGitHub } from "./fakes/github";
import { accountEnvironment, Browser, GOOD_PASSWORD, registerVerified } from "./helpers/accounts";
import { seedTenant } from "./helpers/tenants";

const USER_TOKEN = "ghu_accountUserToken0123456789";
const APP_ID = Number(env.GITHUB_APP_ID);
const ACME = 42;
const UMBRELLA = 43;
const STRANGER = 99;
const ALICE = "alice@example.test";
const BOB = "bob@example.test";

const { mailer } = accountEnvironment();

let githubUser = { id: 7001, login: "octocat" };
let userInstallations: Installation[] = [];

function installation(id: number, login: string): Installation {
  return {
    id,
    app_id: APP_ID,
    account: { id: id * 10, login, type: "Organization" },
    target_id: id * 10,
    target_type: "Organization",
    permissions: { contents: "read", metadata: "read", checks: "write" },
    suspended_at: null,
  };
}

beforeEach(async () => {
  await seedTenant(env, { installationId: ACME, teamId: "T0ACME" });
  await seedTenant(env, { installationId: UMBRELLA, teamId: "T0UMBRELLA" });
  githubUser = { id: 7001, login: "octocat" };
  userInstallations = [installation(ACME, "org42")];
  const gh = createFakeGitHub();
  gh.respond("POST", "/login/oauth/access_token", () => Response.json({ access_token: USER_TOKEN, token_type: "bearer", scope: "" }));
  gh.respond("GET", "/user/installations", ({ headers }) =>
    headers.get("authorization") === `Bearer ${USER_TOKEN}`
      ? Response.json({ total_count: userInstallations.length, installations: userInstallations })
      : Response.json({ message: "Bad credentials" }, { status: 401 }),
  );
  gh.respond("GET", "/user", () => Response.json(githubUser));
  env.__TEST_FETCHER = gh.fetcher;
});

afterEach(() => {
  Reflect.deleteProperty(env, "__TEST_FETCHER");
});

async function signIn(email: string, ip: string): Promise<Browser> {
  const browser = new Browser(ip);
  const res = await browser.submit("/account/login", "/account/login", { email, password: GOOD_PASSWORD });
  expect(res.status).toBe(303);
  return browser;
}

/** Walks the browser through Connect GitHub and the GitHub callback; returns the callback response. */
async function connectGithub(browser: Browser): Promise<Response> {
  const page = await browser.fetch("/account/connect-github");
  let authorize: Response;
  if (page.status === 303) {
    authorize = page;
  } else {
    expect(page.status).toBe(200);
    authorize = await browser.post("/account/connect-github", { csrf: await csrfOfPage(page) });
  }
  expect(authorize.status).toBe(303);
  const location = new URL(authorize.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe("https://github.com/login/oauth/authorize");
  const state = location.searchParams.get("state") ?? "";
  return browser.fetch(`/github/oauth/callback?${new URLSearchParams({ code: "oauth-code", state })}`);
}

async function csrfOfPage(page: Response): Promise<string> {
  const html = await page.text();
  const input = /<input[^>]*name="csrf"[^>]*>/.exec(html)?.[0] ?? "";
  return /value="([^"]*)"/.exec(input)?.[1] ?? "";
}

async function accountRow(email: string): Promise<{ id: string; github_user_id: number | null; github_login: string | null } | null> {
  return env.DB.prepare("SELECT id, github_user_id, github_login FROM users WHERE email_norm = ?1").bind(email).first();
}

describe("what an account session may see", () => {
  it("sees nothing after signing in with a password, and is sent to connect GitHub", async () => {
    await registerVerified(mailer, ALICE);
    const browser = await signIn(ALICE, "203.0.113.30");
    const home = await browser.fetch("/app");
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe("/account/connect-github");
    for (const id of [ACME, UMBRELLA]) expect((await browser.fetch(`/app/${id}`)).status).toBe(404);

    const session = await readAnySession(env, browser.cookieHeader, testClock.now());
    expect(session?.installationIds).toEqual([]);
    expect(session?.githubUserId).toBe(0);
    expect(session?.accountId).toBeTruthy();
  });

  it("covers exactly the installations GitHub says the linked user can access", async () => {
    userInstallations = [installation(ACME, "org42"), installation(STRANGER, "stranger")];
    await registerVerified(mailer, ALICE);
    const browser = await signIn(ALICE, "203.0.113.31");
    const done = await connectGithub(browser);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/app");

    expect((await browser.fetch(`/app/${ACME}`)).status).toBe(200);
    // Installed on the hub, but GitHub did not list it for this person.
    expect((await browser.fetch(`/app/${UMBRELLA}`)).status).toBe(404);
    // Listed by GitHub, but not installed on the hub.
    expect((await browser.fetch(`/app/${STRANGER}`)).status).toBe(404);

    const session = await readAnySession(env, browser.cookieHeader, testClock.now());
    expect(session?.installationIds).toEqual([ACME]);
    expect(session?.githubUserId).toBe(7001);
    expect(session?.githubLogin).toBe("octocat");
    expect(await accountRow(ALICE)).toMatchObject({ github_user_id: 7001, github_login: "octocat" });
  });

  it("gives two accounts the installations of their own GitHub users, whatever their emails say", async () => {
    await registerVerified(mailer, ALICE);
    await registerVerified(mailer, BOB);
    const alice = await signIn(ALICE, "203.0.113.32");
    await connectGithub(alice);

    githubUser = { id: 7002, login: "hubot" };
    userInstallations = [installation(UMBRELLA, "org43")];
    const bob = await signIn(BOB, "203.0.113.33");
    await connectGithub(bob);

    expect((await alice.fetch(`/app/${ACME}`)).status).toBe(200);
    expect((await alice.fetch(`/app/${UMBRELLA}`)).status).toBe(404);
    expect((await bob.fetch(`/app/${UMBRELLA}`)).status).toBe(200);
    expect((await bob.fetch(`/app/${ACME}`)).status).toBe(404);
  });

  it("re-asks GitHub at every sign-in, so revoked access disappears", async () => {
    userInstallations = [installation(ACME, "org42"), installation(UMBRELLA, "org43")];
    await registerVerified(mailer, ALICE);
    const first = await signIn(ALICE, "203.0.113.34");
    await connectGithub(first);
    expect((await first.fetch(`/app/${UMBRELLA}`)).status).toBe(200);

    userInstallations = [installation(ACME, "org42")];
    const second = await signIn(ALICE, "203.0.113.35");
    // Already linked: Connect GitHub goes straight to GitHub without a form.
    expect((await second.fetch("/account/connect-github")).status).toBe(303);
    await connectGithub(second);
    expect((await second.fetch(`/app/${ACME}`)).status).toBe(200);
    expect((await second.fetch(`/app/${UMBRELLA}`)).status).toBe(404);
  });

  it("keeps the account signed in when GitHub lists no hub installation, with no access", async () => {
    userInstallations = [installation(STRANGER, "stranger")];
    await registerVerified(mailer, ALICE);
    const browser = await signIn(ALICE, "203.0.113.36");
    const done = await connectGithub(browser);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain(S.dashboard.noInstallationTitle);
    expect((await browser.fetch(`/app/${ACME}`)).status).toBe(404);
    expect((await accountRow(ALICE))?.github_user_id).toBe(7001);
  });

  it("refuses to link a GitHub user who belongs to another account, and gives the session nothing", async () => {
    await registerVerified(mailer, ALICE);
    await registerVerified(mailer, BOB);
    await connectGithub(await signIn(ALICE, "203.0.113.37"));

    const bob = await signIn(BOB, "203.0.113.38");
    const res = await connectGithub(bob);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(S.account.connect.conflictTitle);
    expect((await bob.fetch(`/app/${ACME}`)).status).toBe(404);
    expect((await accountRow(BOB))?.github_user_id).toBeNull();
    expect((await accountRow(ALICE))?.github_user_id).toBe(7001);
  });

  it("refuses an account that is linked to one GitHub user but authorizes as another", async () => {
    await registerVerified(mailer, ALICE);
    await connectGithub(await signIn(ALICE, "203.0.113.39"));
    githubUser = { id: 7777, login: "someone-else" };
    userInstallations = [installation(UMBRELLA, "org43")];
    const again = await signIn(ALICE, "203.0.113.40");
    const res = await connectGithub(again);
    expect(res.status).toBe(409);
    expect((await again.fetch(`/app/${UMBRELLA}`)).status).toBe(404);
    expect((await accountRow(ALICE))?.github_user_id).toBe(7001);
  });

  it("refuses to finish a connect state from a browser that is not signed in as that account", async () => {
    await registerVerified(mailer, ALICE);
    const alice = await signIn(ALICE, "203.0.113.41");
    const page = await alice.fetch("/account/connect-github");
    const authorize = await alice.post("/account/connect-github", { csrf: await csrfOfPage(page) });
    const state = new URL(authorize.headers.get("location") ?? "").searchParams.get("state") ?? "";

    const stranger = new Browser("203.0.113.42");
    // The stranger holds the oauth state cookie of the same flow but no account session.
    const oauthCookie = alice.cookie("__Host-hookci_oauth");
    const res = await stranger.fetch(`/github/oauth/callback?${new URLSearchParams({ code: "oauth-code", state })}`, {
      headers: { cookie: `__Host-hookci_oauth=${oauthCookie}` },
    });
    expect(res.status).toBe(400);
    expect(stranger.cookie(SESSION_COOKIE)).toBeUndefined();
    expect((await accountRow(ALICE))?.github_user_id).toBeNull();
  });

  it("refuses a connect state completed while accounts are switched off", async () => {
    await registerVerified(mailer, ALICE);
    const alice = await signIn(ALICE, "203.0.113.43");
    const page = await alice.fetch("/account/connect-github");
    const authorize = await alice.post("/account/connect-github", { csrf: await csrfOfPage(page) });
    const state = new URL(authorize.headers.get("location") ?? "").searchParams.get("state") ?? "";
    env.ACCOUNTS_ENABLED = "false";
    const res = await alice.fetch(`/github/oauth/callback?${new URLSearchParams({ code: "oauth-code", state })}`);
    expect(res.status).toBe(400);
  });

  it("rejects a session whose account id was altered", async () => {
    await registerVerified(mailer, ALICE);
    await registerVerified(mailer, BOB);
    const alice = await signIn(ALICE, "203.0.113.44");
    await connectGithub(alice);
    const bobId = (await accountRow(BOB))?.id ?? "";
    const value = alice.cookie(SESSION_COOKIE) ?? "";
    const parts = value.split(".");
    const forged = [...parts.slice(0, -2), bobId, parts.at(-1)].join(".");
    const res = await new Browser("203.0.113.45").fetch(`/app/${ACME}`, { headers: { cookie: `${SESSION_COOKIE}=${forged}` } });
    expect(res.status).toBe(404);
  });

  it("lets the session lapse after 30 minutes", async () => {
    await registerVerified(mailer, ALICE);
    const browser = await signIn(ALICE, "203.0.113.46");
    await connectGithub(browser);
    expect((await browser.fetch(`/app/${ACME}`)).status).toBe(200);
    testClock.advance(31 * 60_000);
    expect((await browser.fetch(`/app/${ACME}`)).status).toBe(404);
  });

  it("sends an unauthenticated visit to Connect GitHub back to the sign-in page", async () => {
    const res = await new Browser().fetch("/account/connect-github");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/login");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("refuses the Connect GitHub POST without a csrf token", async () => {
    await registerVerified(mailer, ALICE);
    const alice = await signIn(ALICE, "203.0.113.47");
    const res = await alice.post("/account/connect-github", {});
    expect(res.status).toBe(403);
    const before = await env.DB.prepare("SELECT count(*) AS n FROM oauth_states").first<{ n: number }>();
    expect(before?.n).toBe(0);
  });
});

describe("GET /app with accounts on", () => {
  it("shows the account sign-in page, still offering GitHub", async () => {
    const res = await new Browser().fetch("/app");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="csrf"');
    expect(html).toContain('action="/account/login"');
    expect(html).toContain('href="/app/login"');
  });

  it("shows the old GitHub-only page when accounts are off", async () => {
    env.ACCOUNTS_ENABLED = "false";
    const res = await new Browser().fetch("/app");
    const html = await res.text();
    expect(html).toContain('href="/app/login"');
    expect(html).not.toContain("/account/");
    expect(html).not.toContain("<script");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});
