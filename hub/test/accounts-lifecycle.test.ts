import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { issueSession, SESSION_COOKIE } from "../src/oauth/state";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { accountEnvironment, Browser, createFakeGoogle, GOOD_PASSWORD, type GoogleProfile, registerVerified, tokenIn } from "./helpers/accounts";
import { seedTenant } from "./helpers/tenants";

const E = S.account.errors;
const X = S.account.delete;
const ACME = 42;
const ALICE = "alice@example.test";
const BOB = "bob@example.test";
const GOOGLE_PROFILE: GoogleProfile = { sub: "google-sub-9", email: "gina@example.test", email_verified: true };

const { mailer } = accountEnvironment({ google: true });

async function userRow(email: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM users WHERE email_norm = ?1").bind(email).first();
}

async function count(table: "users" | "email_tokens"): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
}

async function signInWithPassword(email: string, ip = "203.0.113.40"): Promise<Browser> {
  const browser = new Browser(ip);
  const res = await browser.submit("/account/login", "/account/login", { email, password: GOOD_PASSWORD });
  expect(res.status).toBe(303);
  expect(browser.cookie(SESSION_COOKIE)).toBeTruthy();
  return browser;
}

async function signInWithGoogle(profile = GOOGLE_PROFILE): Promise<Browser> {
  const google = createFakeGoogle();
  google.answer(profile);
  env.__TEST_FETCHER = google.service.fetcher;
  const browser = new Browser("203.0.113.41");
  const start = await browser.fetch("/account/google/start");
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const res = await browser.fetch(`/account/google/callback?${new URLSearchParams({ code: "auth-code", state })}`);
  expect(res.status).toBe(303);
  expect(browser.cookie(SESSION_COOKIE)).toBeTruthy();
  return browser;
}

/** A browser holding a session that covers ACME, the way a signed-in GitHub user (optionally with an email account) has one. */
async function dashboardBrowser(accountId?: string): Promise<Browser> {
  await seedTenant(env, { installationId: ACME, teamId: "T0ACME" });
  const browser = new Browser("203.0.113.42");
  browser.adopt(await issueSession(env, { installationIds: [ACME], githubUserId: 7001, githubLogin: "octocat", ...(accountId ? { accountId } : {}) }, testClock.now()));
  return browser;
}

describe("the emailed verification link", () => {
  it("only asks for confirmation when opened, so a mail scanner cannot use it up", async () => {
    const browser = new Browser("203.0.113.50");
    await browser.submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    const token = tokenIn(mailer.sent[0]!, "verify");

    for (const viewer of [browser, new Browser("203.0.113.51"), new Browser("203.0.113.52")]) {
      const page = await viewer.fetch(`/account/verify?token=${token}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain(S.account.verifyConfirm.title);
      expect(html).toContain('action="/account/verify"');
      expect(html).toContain(`value="${token}"`);
    }
    expect((await userRow(ALICE))?.email_verified_at).toBeNull();

    const csrf = await browser.csrfFrom(`/account/verify?token=${token}`);
    const done = await browser.confirmVerify(token);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain(S.account.verify.okTitle);
    expect((await userRow(ALICE))?.email_verified_at).not.toBeNull();

    expect((await browser.post("/account/verify", { token, csrf })).status).toBe(400);
    expect((await browser.fetch(`/account/verify?token=${token}`)).status).toBe(400);
  });

  it("says the link is not valid, without a form, for a token that was never mailed", async () => {
    const page = await new Browser().fetch("/account/verify?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(page.status).toBe(400);
    const html = await page.text();
    expect(html).toContain(S.account.verify.invalidTitle);
    expect(html).not.toContain('action="/account/verify"');
  });

  it("refuses the confirmation without a csrf token or from another origin, and leaves the token usable", async () => {
    const browser = new Browser("203.0.113.53");
    await browser.submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    const token = tokenIn(mailer.sent[0]!, "verify");

    const bare = await browser.post("/account/verify", { token });
    expect(bare.status).toBe(403);
    expect(await bare.text()).toContain(E.csrf);

    const csrf = await browser.csrfFrom(`/account/verify?token=${token}`);
    const foreign = await browser.post("/account/verify", { token, csrf }, { origin: "https://evil.test" });
    expect(foreign.status).toBe(403);
    expect((await userRow(ALICE))?.email_verified_at).toBeNull();

    expect((await browser.confirmVerify(token)).status).toBe(200);
  });
});

describe("sign out", () => {
  it("clears the session cookie and sends the browser to /app", async () => {
    await registerVerified(mailer, ALICE);
    const browser = await signInWithPassword(ALICE);
    const res = await browser.submit("/account/settings", "/account/logout", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/app");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-hookci_session=; .*Max-Age=0/);
    expect(browser.cookie(SESSION_COOKIE)).toBeUndefined();
    expect((await browser.fetch("/account/settings")).status).toBe(303);
  });

  it("signs out after the renewal window with one clearing cookie and no renewed one", async () => {
    await registerVerified(mailer, ALICE);
    const browser = await signInWithPassword(ALICE);
    testClock.advance(10 * 60_000);
    const res = await browser.submit("/account/settings", "/account/logout", {});
    const sessionCookies = res.headers.getSetCookie().filter((v) => v.startsWith(`${SESSION_COOKIE}=`));
    expect(sessionCookies).toHaveLength(1);
    expect(sessionCookies[0]).toMatch(/Max-Age=0/);
    expect(browser.cookie(SESSION_COOKIE)).toBeUndefined();
  });

  it("refuses a sign out without a csrf token or from another origin, and keeps the session", async () => {
    await registerVerified(mailer, ALICE);
    const browser = await signInWithPassword(ALICE);

    const bare = await browser.post("/account/logout", {});
    expect(bare.status).toBe(403);
    expect(await bare.text()).toContain(E.csrf);

    const csrf = await browser.csrfFrom("/account/settings");
    const foreign = await browser.post("/account/logout", { csrf }, { origin: "https://evil.test" });
    expect(foreign.status).toBe(403);
    expect(browser.cookie(SESSION_COOKIE)).toBeTruthy();
    expect((await browser.fetch("/account/settings")).status).toBe(200);
  });

  it("is a button in the dashboard header, which the dashboard CSP allows to post to this origin", async () => {
    const accountId = await registerVerified(mailer, ALICE);
    const browser = await dashboardBrowser(accountId);
    const page = await browser.fetch(`/app/${ACME}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    const html = await page.text();
    expect(html).toContain('action="/account/logout"');
    expect(html).toContain(`>${S.dashboard.signOut}<`);
    expect(html).toContain('href="/account/settings"');

    const res = await browser.submit(`/app/${ACME}`, "/account/logout", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/app");
    expect(browser.cookie(SESSION_COOKIE)).toBeUndefined();
    const home = await browser.fetch("/app");
    expect(await home.text()).toContain(S.account.login.title);
  });

  it("offers a plain GitHub session only the sign out button, not settings", async () => {
    const browser = await dashboardBrowser();
    const html = await (await browser.fetch(`/app/${ACME}`)).text();
    expect(html).toContain('action="/account/logout"');
    expect(html).not.toContain("/account/settings");
  });

  it("shows no header controls when accounts are off, and still lets the range form submit", async () => {
    env.ACCOUNTS_ENABLED = "false";
    const browser = await dashboardBrowser();
    const page = await browser.fetch(`/app/${ACME}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    const html = await page.text();
    expect(html).not.toContain("/account/");
    expect(html).not.toContain(S.dashboard.signOut);
  });
});

describe("account settings", () => {
  it("sends a browser without an account session to sign in", async () => {
    const res = await new Browser().fetch("/account/settings");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/login");
  });

  it("shows the email, that GitHub is not connected, and the sign out and delete controls", async () => {
    await registerVerified(mailer, ALICE);
    const browser = await signInWithPassword(ALICE);
    const page = await browser.fetch("/account/settings");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain(S.account.settings.title);
    expect(html).toContain(ALICE);
    expect(html).toContain(S.account.settings.githubNone);
    expect(html).toContain('action="/account/connect-github"');
    expect(html).toContain('href="#i-octocat"');
    expect(html).toContain('<symbol id="i-octocat"');
    expect(html).toContain('action="/account/logout"');
    expect(html).toContain('href="/account/delete"');
  });

  it("shows the linked GitHub login and no connect button once linked", async () => {
    await registerVerified(mailer, ALICE);
    await env.DB.prepare("UPDATE users SET github_user_id = 7001, github_login = 'octocat' WHERE email_norm = ?1").bind(ALICE).run();
    const browser = await signInWithPassword(ALICE);
    const html = await (await browser.fetch("/account/settings")).text();
    expect(html).toContain("octocat");
    expect(html).not.toContain('action="/account/connect-github"');
  });
});

describe("delete account", () => {
  it("sends a browser without an account session to sign in", async () => {
    const res = await new Browser().fetch("/account/delete");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/login");
  });

  it("asks a password account for its password", async () => {
    await registerVerified(mailer, ALICE);
    const browser = await signInWithPassword(ALICE);
    const html = await (await browser.fetch("/account/delete")).text();
    expect(html).toContain(X.title);
    expect(html).toContain('name="password"');
    expect(html).toContain('action="/account/delete"');
  });

  it("keeps the account on a wrong password and counts the guess toward the sign-in lockout", async () => {
    await registerVerified(mailer, ALICE);
    const browser = await signInWithPassword(ALICE);
    const wrong = await browser.submit("/account/delete", "/account/delete", { password: "not the password 1" });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain(X.wrongPassword);
    expect(await userRow(ALICE)).not.toBeNull();
    expect(browser.cookie(SESSION_COOKIE)).toBeTruthy();

    for (let i = 1; i < 5; i++) await browser.submit("/account/delete", "/account/delete", { password: "not the password 1" });
    const locked = await browser.submit("/account/delete", "/account/delete", { password: GOOD_PASSWORD });
    expect(locked.status).toBe(429);
    expect(await userRow(ALICE)).not.toBeNull();
  });

  it("deletes the account, its tokens and the session with the right password, and leaves other accounts alone", async () => {
    await registerVerified(mailer, ALICE);
    await registerVerified(mailer, BOB);
    const browser = await signInWithPassword(ALICE);
    const oldSession = browser.cookie(SESSION_COOKIE) ?? "";
    expect(await count("users")).toBe(2);

    const res = await browser.submit("/account/delete", "/account/delete", { password: GOOD_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain(X.doneTitle);
    expect(await userRow(ALICE)).toBeNull();
    expect(await userRow(BOB)).not.toBeNull();
    expect(await count("users")).toBe(1);
    expect(browser.cookie(SESSION_COOKIE)).toBeUndefined();

    // A copy of the old cookie, which stays signed until it expires, no longer reaches an account.
    const replay = new Browser();
    replay.adopt(`${SESSION_COOKIE}=${oldSession}`);
    expect((await replay.fetch("/account/settings")).status).toBe(303);

    // The address can sign up again as a new account.
    expect((await new Browser("203.0.113.60").submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD })).status).toBe(200);
  });

  it("removes pending emailed tokens with the account", async () => {
    await registerVerified(mailer, ALICE);
    const browser = await signInWithPassword(ALICE);
    await new Browser("203.0.113.61").submit("/account/forgot-password", "/account/forgot-password", { email: ALICE });
    expect(await count("email_tokens")).toBeGreaterThan(0);
    await browser.submit("/account/delete", "/account/delete", { password: GOOD_PASSWORD });
    expect(await count("email_tokens")).toBe(0);
  });

  it("refuses a delete without a csrf token or from another origin", async () => {
    await registerVerified(mailer, ALICE);
    const browser = await signInWithPassword(ALICE);

    const bare = await browser.post("/account/delete", { password: GOOD_PASSWORD });
    expect(bare.status).toBe(403);
    expect(await bare.text()).toContain(E.csrf);

    const csrf = await browser.csrfFrom("/account/delete");
    const foreign = await browser.post("/account/delete", { password: GOOD_PASSWORD, csrf }, { origin: "https://evil.test" });
    expect(foreign.status).toBe(403);
    expect(await userRow(ALICE)).not.toBeNull();
  });

  it("does nothing for a valid form posted without an account session", async () => {
    await registerVerified(mailer, ALICE);
    const browser = new Browser("203.0.113.62");
    const res = await browser.submit("/account/login", "/account/delete", { password: GOOD_PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/login");
    expect(await userRow(ALICE)).not.toBeNull();
  });

  it("asks an account without a password to type its email, and refuses any other", async () => {
    const browser = await signInWithGoogle();
    const html = await (await browser.fetch("/account/delete")).text();
    expect(html).toContain('name="email"');
    expect(html).not.toContain('name="password"');

    const wrong = await browser.submit("/account/delete", "/account/delete", { email: ALICE });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain(X.wrongEmail);
    expect(await userRow("gina@example.test")).not.toBeNull();

    const right = await browser.submit("/account/delete", "/account/delete", { email: " Gina@Example.test " });
    expect(right.status).toBe(200);
    expect(await right.text()).toContain(X.doneTitle);
    expect(await userRow("gina@example.test")).toBeNull();
    expect(browser.cookie(SESSION_COOKIE)).toBeUndefined();
  });
});

describe("with accounts off", () => {
  it("answers the standard 404 for every new route and the dashboard has no account controls", async () => {
    env.ACCOUNTS_ENABLED = "false";
    const browser = new Browser();
    for (const path of ["/account/settings", "/account/delete"]) {
      const res = await browser.fetch(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    for (const path of ["/account/verify", "/account/logout", "/account/delete"]) {
      const res = await browser.post(path, { token: "x", csrf: "x" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});
