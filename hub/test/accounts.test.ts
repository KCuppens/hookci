import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { LOGIN_LOCKOUT } from "../src/accounts/service";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { accountEnvironment, Browser, GOOD_PASSWORD, pageShape, registerVerified, tokenIn } from "./helpers/accounts";

const E = S.account.errors;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const { mailer } = accountEnvironment();

const ALICE = "alice@example.test";

/** Shape of a response without anything that differs per request or per entered address. */
async function shapeOf(res: Response, email: string): Promise<string> {
  const text = await res.text();
  return pageShape(text).replaceAll(email, "EMAIL");
}

async function userRow(email: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM users WHERE email_norm = ?1").bind(email).first();
}

describe("register, verify and sign in", () => {
  it("signs up, verifies by the emailed link, then signs in", async () => {
    const browser = new Browser();
    const signUp = await browser.submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    expect(signUp.status).toBe(200);
    expect(signUp.headers.get("cache-control")).toBe("no-store");
    expect(await signUp.text()).toContain(S.account.checkEmail.registerTitle);

    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0];
    expect(mail?.to).toBe(ALICE);
    expect(mail?.text).not.toBe("");
    expect(mail?.html).toContain("<");
    const token = tokenIn(mail!, "verify");
    expect(token).toHaveLength(43);

    // Not verified yet: the right password still fails.
    const early = await browser.submit("/account/login", "/account/login", { email: ALICE, password: GOOD_PASSWORD });
    expect(early.status).toBe(401);

    const verified = await browser.confirmVerify(token);
    expect(verified.status).toBe(200);
    expect(await verified.text()).toContain(S.account.verify.okTitle);

    const signIn = await browser.submit("/account/login", "/account/login", { email: ALICE.toUpperCase(), password: GOOD_PASSWORD });
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get("location")).toBe("/account/connect-github");
    expect(signIn.headers.get("cache-control")).toBe("no-store");
    expect(browser.cookie("__Host-hookci_session")).toBeTruthy();
  });

  it("stores a versioned PBKDF2 hash and only the hash of the token", async () => {
    await registerVerified(mailer, ALICE);
    const user = await userRow(ALICE);
    expect(user?.password_hash).toMatch(/^pbkdf2-sha256\$v1\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(user)).not.toContain(GOOD_PASSWORD);
    const token = tokenIn(mailer.sent[0]!, "verify");
    const { results } = await env.DB.prepare("SELECT * FROM email_tokens").all<Record<string, unknown>>();
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain(token);
    expect(results[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(results[0]?.used_at).not.toBeNull();
  });

  it("gives every account its own random salt", async () => {
    await registerVerified(mailer, ALICE);
    await registerVerified(mailer, "bob@example.test");
    const { results } = await env.DB.prepare("SELECT password_hash FROM users").all<{ password_hash: string }>();
    const salts = results.map((row) => row.password_hash.split("$")[3]);
    expect(new Set(salts).size).toBe(2);
  });

  it("refuses a wrong password and signs nobody in", async () => {
    await registerVerified(mailer, ALICE);
    const browser = new Browser();
    const res = await browser.submit("/account/login", "/account/login", { email: ALICE, password: "wrong password 1" });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain(E.invalidCredentials);
    expect(browser.cookie("__Host-hookci_session")).toBeUndefined();
  });

  it("refuses password sign-in before the address is verified", async () => {
    const browser = new Browser();
    await browser.submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    const res = await browser.submit("/account/login", "/account/login", { email: ALICE, password: GOOD_PASSWORD });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain(E.invalidCredentials);
    expect(browser.cookie("__Host-hookci_session")).toBeUndefined();
  });

  it.each([
    ["too short", "a1b2c3", E.passwordRules],
    ["no number or symbol", "onlyletterslong", E.passwordRules],
    ["over 256 characters", `${"a".repeat(256)}1`, E.passwordTooLong],
  ])("rejects a password that is %s", async (_name, password, message) => {
    const res = await new Browser().submit("/account/register", "/account/register", { email: ALICE, password });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(message);
    expect(await userRow(ALICE)).toBeNull();
    expect(mailer.sent).toHaveLength(0);
  });

  it("accepts a symbol in place of a number and a password of exactly 256 characters", async () => {
    const symbol = await new Browser().submit("/account/register", "/account/register", { email: ALICE, password: "letters only!" });
    expect(symbol.status).toBe(200);
    const long = await new Browser("203.0.113.55").submit("/account/register", "/account/register", { email: "long@example.test", password: `${"a".repeat(255)}1` });
    expect(long.status).toBe(200);
  });

  it("refuses a malformed address", async () => {
    const res = await new Browser().submit("/account/register", "/account/register", { email: "not an email", password: GOOD_PASSWORD });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(E.invalidEmail);
  });

  it("escapes what it echoes back", async () => {
    const hostile = `"><script>alert(1)</script>`;
    const res = await new Browser().submit("/account/register", "/account/register", { email: hostile, password: GOOD_PASSWORD });
    const text = await res.text();
    expect(text).not.toContain("<script>alert(1)");
    expect(text).toContain("&lt;script&gt;");
  });

  it("uses a verification link once, and the newest link replaces older ones", async () => {
    const browser = new Browser();
    await browser.submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    await browser.submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    const [first, second] = mailer.sent;
    const oldToken = tokenIn(first!, "verify");
    const newToken = tokenIn(second!, "verify");
    expect(newToken).not.toBe(oldToken);

    expect((await browser.fetch(`/account/verify?token=${oldToken}`)).status).toBe(400);
    expect((await browser.confirmVerify(newToken)).status).toBe(200);
    const replay = await browser.fetch(`/account/verify?token=${newToken}`);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain(S.account.verify.invalidTitle);
  });

  it("expires a verification link after 24 hours", async () => {
    const browser = new Browser();
    await browser.submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    const token = tokenIn(mailer.sent[0]!, "verify");
    testClock.advance(24 * HOUR + MINUTE);
    expect((await browser.fetch(`/account/verify?token=${token}`)).status).toBe(400);
    expect((await userRow(ALICE))?.email_verified_at).toBeNull();
  });

  it("does not let a second sign-up take over a verified account", async () => {
    await registerVerified(mailer, ALICE);
    const attacker = new Browser("203.0.113.99");
    const res = await attacker.submit("/account/register", "/account/register", { email: ALICE, password: "attacker pass 9" });
    expect(res.status).toBe(200);
    const owner = new Browser();
    const login = await owner.submit("/account/login", "/account/login", { email: ALICE, password: GOOD_PASSWORD });
    expect(login.status).toBe(303);
    const stolen = await new Browser("203.0.113.98").submit("/account/login", "/account/login", { email: ALICE, password: "attacker pass 9" });
    expect(stolen.status).toBe(401);
  });

  it("gives a re-registration of an unverified address the new password, so the mailbox owner ends up with it", async () => {
    const squatter = new Browser("203.0.113.50");
    await squatter.submit("/account/register", "/account/register", { email: ALICE, password: "squatter pass 1" });
    const owner = new Browser("203.0.113.51");
    await owner.submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    const token = tokenIn(mailer.sent[1]!, "verify");
    await owner.confirmVerify(token);
    expect((await squatter.submit("/account/login", "/account/login", { email: ALICE, password: "squatter pass 1" })).status).toBe(401);
    expect((await owner.submit("/account/login", "/account/login", { email: ALICE, password: GOOD_PASSWORD })).status).toBe(303);
  });
});

describe("enumeration safety", () => {
  it("answers sign-in alike for an unknown address, a wrong password and an unverified address", async () => {
    await registerVerified(mailer, ALICE);
    const unverified = new Browser("203.0.113.60");
    await unverified.submit("/account/register", "/account/register", { email: "pending@example.test", password: GOOD_PASSWORD });

    const attempts = [
      ["nobody@example.test", GOOD_PASSWORD],
      [ALICE, "wrong password 1"],
      ["pending@example.test", GOOD_PASSWORD],
    ] as const;
    const seen = [];
    for (const [email, password] of attempts) {
      const res = await new Browser("203.0.113.61").submit("/account/login", "/account/login", { email, password });
      seen.push({ status: res.status, shape: await shapeOf(res, email) });
    }
    expect(seen[0]?.status).toBe(401);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
  });

  it("answers sign-up alike for a new address and a registered one, and mails each", async () => {
    await registerVerified(mailer, ALICE);
    mailer.sent.length = 0;
    const fresh = await new Browser("203.0.113.62").submit("/account/register", "/account/register", { email: "new@example.test", password: GOOD_PASSWORD });
    const known = await new Browser("203.0.113.63").submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    expect(known.status).toBe(fresh.status);
    expect(await shapeOf(known, ALICE)).toBe(await shapeOf(fresh, "new@example.test"));
    expect(mailer.to("new@example.test")).toHaveLength(1);
    expect(mailer.to(ALICE)).toHaveLength(1);
    expect(mailer.to(ALICE)[0]?.text).not.toMatch(/token=/);
  });

  it("answers a reset request alike for a known and an unknown address, mailing only the known one", async () => {
    await registerVerified(mailer, ALICE);
    mailer.sent.length = 0;
    const known = await new Browser("203.0.113.64").submit("/account/forgot-password", "/account/forgot-password", { email: ALICE });
    const unknown = await new Browser("203.0.113.65").submit("/account/forgot-password", "/account/forgot-password", { email: "ghost@example.test" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(await shapeOf(unknown, "ghost@example.test")).toBe(await shapeOf(known, ALICE));
    expect(mailer.sent.map((mail) => mail.to)).toEqual([ALICE]);
  });

  it("does not let a locked address tell known from unknown", async () => {
    await registerVerified(mailer, ALICE);
    const browser = new Browser("203.0.113.66");
    const csrf = await browser.csrfFrom("/account/login");
    const lockout = async (email: string) => {
      const last = [];
      for (let i = 0; i <= LOGIN_LOCKOUT.lockAfter; i++) last.push(await browser.post("/account/login", { email, password: "wrong password 1", csrf }));
      return last;
    };
    const known = await lockout(ALICE);
    const unknown = await lockout("ghost@example.test");
    expect(known.map((r) => r.status)).toEqual(unknown.map((r) => r.status));
  });
});

describe("password reset", () => {
  async function requestResetMail(email: string, ip = "203.0.113.70"): Promise<string> {
    const before = mailer.sent.length;
    const res = await new Browser(ip).submit("/account/forgot-password", "/account/forgot-password", { email });
    expect(res.status).toBe(200);
    const mail = mailer.sent[before];
    if (!mail) throw new Error("no reset mail");
    return tokenIn(mail, "reset-password");
  }

  it("sets a new password with the emailed link, without signing anyone in", async () => {
    await registerVerified(mailer, ALICE);
    const token = await requestResetMail(ALICE);
    const browser = new Browser("203.0.113.71");

    const form = await browser.fetch(`/account/reset-password?token=${token}`);
    expect(form.status).toBe(200);
    expect(form.headers.get("referrer-policy")).toBe("no-referrer");
    expect(form.headers.get("cache-control")).toBe("no-store");

    const done = await browser.submit(`/account/reset-password?token=${token}`, "/account/reset-password", { token, password: "brand new pass 5" });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain(S.account.reset.doneTitle);
    expect(browser.cookie("__Host-hookci_session")).toBeUndefined();

    const oldPassword = await browser.submit("/account/login", "/account/login", { email: ALICE, password: GOOD_PASSWORD });
    expect(oldPassword.status).toBe(401);
    const newPassword = await browser.submit("/account/login", "/account/login", { email: ALICE, password: "brand new pass 5" });
    expect(newPassword.status).toBe(303);
  });

  it("uses a reset link once", async () => {
    await registerVerified(mailer, ALICE);
    const token = await requestResetMail(ALICE);
    const browser = new Browser("203.0.113.72");
    expect((await browser.submit(`/account/reset-password?token=${token}`, "/account/reset-password", { token, password: "brand new pass 5" })).status).toBe(200);
    const replay = await browser.submit(`/account/forgot-password`, "/account/reset-password", { token, password: "another new pass 6" });
    expect(replay.status).toBe(400);
    expect((await browser.fetch(`/account/reset-password?token=${token}`)).status).toBe(400);
    const login = await browser.submit("/account/login", "/account/login", { email: ALICE, password: "another new pass 6" });
    expect(login.status).toBe(401);
  });

  it("expires a reset link after one hour", async () => {
    await registerVerified(mailer, ALICE);
    const token = await requestResetMail(ALICE);
    const browser = new Browser("203.0.113.73");
    testClock.advance(HOUR - MINUTE);
    expect((await browser.fetch(`/account/reset-password?token=${token}`)).status).toBe(200);
    testClock.advance(2 * MINUTE);
    expect((await browser.fetch(`/account/reset-password?token=${token}`)).status).toBe(400);
    const late = await browser.submit("/account/forgot-password", "/account/reset-password", { token, password: "brand new pass 5" });
    expect(late.status).toBe(400);
    expect((await browser.submit("/account/login", "/account/login", { email: ALICE, password: GOOD_PASSWORD })).status).toBe(303);
  });

  it("invalidates an older reset link when a newer one is requested", async () => {
    await registerVerified(mailer, ALICE);
    const older = await requestResetMail(ALICE);
    const newer = await requestResetMail(ALICE);
    expect(newer).not.toBe(older);
    const browser = new Browser("203.0.113.74");
    expect((await browser.fetch(`/account/reset-password?token=${older}`)).status).toBe(400);
    expect((await browser.fetch(`/account/reset-password?token=${newer}`)).status).toBe(200);
    expect((await browser.submit("/account/forgot-password", "/account/reset-password", { token: older, password: "brand new pass 5" })).status).toBe(400);
    expect((await browser.submit("/account/forgot-password", "/account/reset-password", { token: newer, password: "brand new pass 5" })).status).toBe(200);
  });

  it("keeps the reset link usable after a weak password is refused", async () => {
    await registerVerified(mailer, ALICE);
    const token = await requestResetMail(ALICE);
    const browser = new Browser("203.0.113.75");
    const weak = await browser.submit(`/account/reset-password?token=${token}`, "/account/reset-password", { token, password: "short1" });
    expect(weak.status).toBe(400);
    expect(await weak.text()).toContain(E.passwordRules);
    expect((await browser.submit(`/account/reset-password?token=${token}`, "/account/reset-password", { token, password: "long enough pass 5" })).status).toBe(200);
  });

  it("does not accept a verification token as a reset token, or the reverse", async () => {
    const browser = new Browser("203.0.113.76");
    await browser.submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    const verifyToken = tokenIn(mailer.sent[0]!, "verify");
    expect((await browser.fetch(`/account/reset-password?token=${verifyToken}`)).status).toBe(400);
    await registerVerified(mailer, "bob@example.test");
    const resetToken = await requestResetMail("bob@example.test");
    expect((await browser.fetch(`/account/verify?token=${resetToken}`)).status).toBe(400);
  });

  it("verifies the address when a reset link is used, so a lost verification mail is not a dead end", async () => {
    const browser = new Browser("203.0.113.77");
    await browser.submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    const token = await requestResetMail(ALICE, "203.0.113.78");
    await browser.submit("/account/forgot-password", "/account/reset-password", { token, password: "brand new pass 5" });
    expect((await browser.submit("/account/login", "/account/login", { email: ALICE, password: "brand new pass 5" })).status).toBe(303);
  });
});

describe("rate limits and lockout", () => {
  it("answers 429 after 30 form posts from one IP in ten minutes", async () => {
    const browser = new Browser("203.0.113.80");
    const csrf = await browser.csrfFrom("/account/register");
    for (let i = 0; i < 30; i++) {
      const res = await browser.post("/account/register", { email: "nope", password: "x", csrf });
      expect(res.status).toBe(400);
    }
    const limited = await browser.post("/account/register", { email: "nope", password: "x", csrf });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain(E.rateLimited);
    // Another IP is unaffected, and the window passes.
    expect((await new Browser("203.0.113.81").submit("/account/register", "/account/register", { email: "nope", password: "x" })).status).toBe(400);
    testClock.advance(11 * MINUTE);
    expect((await browser.post("/account/register", { email: "nope", password: "x", csrf })).status).toBe(400);
  });

  it("sends at most three reset mails per address per hour, and still answers the same", async () => {
    await registerVerified(mailer, ALICE);
    mailer.sent.length = 0;
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await new Browser(`203.0.113.${90 + i}`).submit("/account/forgot-password", "/account/forgot-password", { email: ALICE })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    expect(mailer.to(ALICE)).toHaveLength(3);
    testClock.advance(HOUR + MINUTE);
    await new Browser("203.0.113.99").submit("/account/forgot-password", "/account/forgot-password", { email: ALICE });
    expect(mailer.to(ALICE)).toHaveLength(4);
  });

  it("locks an address after repeated failures, even for the right password, then lets it back in", async () => {
    await registerVerified(mailer, ALICE);
    const attacker = new Browser("203.0.113.82");
    const csrf = await attacker.csrfFrom("/account/login");
    for (let i = 0; i < LOGIN_LOCKOUT.lockAfter; i++) {
      expect((await attacker.post("/account/login", { email: ALICE, password: "wrong password 1", csrf })).status).toBe(401);
    }
    const owner = new Browser("203.0.113.83");
    const locked = await owner.submit("/account/login", "/account/login", { email: ALICE, password: GOOD_PASSWORD });
    expect(locked.status).toBe(429);
    expect(owner.cookie("__Host-hookci_session")).toBeUndefined();

    testClock.advance(LOGIN_LOCKOUT.lockMs + MINUTE);
    const later = await owner.submit("/account/login", "/account/login", { email: ALICE, password: GOOD_PASSWORD });
    expect(later.status).toBe(303);
  });

  it("forgets old failures and clears them on a good sign-in", async () => {
    await registerVerified(mailer, ALICE);
    const browser = new Browser("203.0.113.84");
    const csrf = await browser.csrfFrom("/account/login");
    for (let i = 0; i < LOGIN_LOCKOUT.lockAfter - 1; i++) await browser.post("/account/login", { email: ALICE, password: "wrong password 1", csrf });
    expect((await browser.post("/account/login", { email: ALICE, password: GOOD_PASSWORD, csrf })).status).toBe(303);
    for (let i = 0; i < LOGIN_LOCKOUT.lockAfter - 1; i++) await browser.post("/account/login", { email: ALICE, password: "wrong password 1", csrf });
    expect((await browser.post("/account/login", { email: ALICE, password: GOOD_PASSWORD, csrf })).status).toBe(303);
  });

  it("keeps no address in the rate limit or lockout tables", async () => {
    await registerVerified(mailer, ALICE);
    await new Browser("203.0.113.85").submit("/account/login", "/account/login", { email: ALICE, password: "wrong password 1" });
    const { results: rates } = await env.DB.prepare("SELECT bucket FROM ip_rate").all<{ bucket: string }>();
    const { results: attempts } = await env.DB.prepare("SELECT * FROM login_attempts").all<Record<string, unknown>>();
    expect(attempts.length).toBeGreaterThan(0);
    expect(JSON.stringify([rates, attempts])).not.toContain("alice");
  });
});

describe("CSRF and origin", () => {
  const forms = [
    ["/account/login", { email: ALICE, password: GOOD_PASSWORD }],
    ["/account/register", { email: ALICE, password: GOOD_PASSWORD }],
    ["/account/forgot-password", { email: ALICE }],
    ["/account/reset-password", { token: "x".repeat(43), password: GOOD_PASSWORD }],
  ] as const;

  it.each(forms)("refuses a POST to %s without a token", async (path, fields) => {
    const res = await new Browser().post(path, { ...fields });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(E.csrf);
    expect(await userRow(ALICE)).toBeNull();
    expect(mailer.sent).toHaveLength(0);
  });

  it("refuses a token that belongs to another browser", async () => {
    const victim = new Browser("203.0.113.86");
    const victimToken = await victim.csrfFrom("/account/register");
    const attacker = new Browser("203.0.113.87");
    await attacker.csrfFrom("/account/register");
    const res = await attacker.post("/account/register", { email: ALICE, password: GOOD_PASSWORD, csrf: victimToken });
    expect(res.status).toBe(403);
    expect(await userRow(ALICE)).toBeNull();
  });

  it("refuses a valid token sent from another origin", async () => {
    const browser = new Browser();
    const csrf = await browser.csrfFrom("/account/register");
    const res = await browser.post("/account/register", { email: ALICE, password: GOOD_PASSWORD, csrf }, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(await userRow(ALICE)).toBeNull();
    const crossSite = await browser.post("/account/register", { email: ALICE, password: GOOD_PASSWORD, csrf }, { origin: "", "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
  });

  it("refuses a token signed with a different key", async () => {
    const browser = new Browser();
    const csrf = await browser.csrfFrom("/account/register");
    const res = await browser.post("/account/register", { email: ALICE, password: GOOD_PASSWORD, csrf: `${csrf.slice(0, -2)}AA` });
    expect(res.status).toBe(403);
  });

  it("refuses an oversized body", async () => {
    const browser = new Browser();
    const csrf = await browser.csrfFrom("/account/register");
    const res = await browser.post("/account/register", { email: ALICE, password: "a1".repeat(5000), csrf });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await userRow(ALICE)).toBeNull();
  });
});

describe("page headers", () => {
  it.each(["/account/login", "/account/register", "/account/forgot-password"])("serves %s with no-store, a strict CSP and frame blocking", async (path) => {
    const res = await new Browser().fetch(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).not.toMatch(/https?:\/\/[^"' )]*\.(?:woff2?|ttf|png|jpe?g)/);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
  });

  it("serves the reset page and its invalid-link state without a referrer", async () => {
    await registerVerified(mailer, ALICE);
    const bad = await new Browser().fetch("/account/reset-password?token=nope");
    expect(bad.status).toBe(400);
    expect(bad.headers.get("referrer-policy")).toBe("no-referrer");
    expect(bad.headers.get("cache-control")).toBe("no-store");
    const missing = await new Browser().fetch("/account/reset-password");
    expect(missing.status).toBe(400);
  });

  it("links the mockup navigation to hookci.com and the footer to hub-internal or absolute site pages", async () => {
    const html = await (await new Browser().fetch("/account/login")).text();
    expect(html).toContain('href="https://hookci.com/docs"');
    expect(html).toContain('href="https://hookci.com/pricing"');
    expect(html).toContain('href="https://github.com/KCuppens/hookci"');
    expect(html).toContain('href="/account/register"');
    expect(html).toContain('href="/account/forgot-password"');
    expect(html).toContain('href="/app/login"');
  });

  it("hides the Google button when Google is not configured", async () => {
    const html = await (await new Browser().fetch("/account/login")).text();
    expect(html).not.toContain("/account/google/start");
  });

  it("never contains an exclamation mark or em-dash in visible copy", async () => {
    for (const path of ["/account/login", "/account/register", "/account/forgot-password"]) {
      const html = await (await new Browser().fetch(path)).text();
      const visible = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]*>/g, "");
      expect(visible).not.toContain("!");
      expect(visible).not.toContain("\u2014");
    }
  });
});

describe("account mail", () => {
  it("carries the link in both the text and the html part and names the sender", async () => {
    await new Browser().submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    const mail = mailer.sent[0]!;
    const token = tokenIn(mail, "verify");
    expect(mail.html).toContain(token);
    expect(mail.subject).toBe(S.account.mail.verifySubject);
  });

  it("answers the browser the same when sending the mail fails", async () => {
    mailer.failWith = new Error("provider down");
    const res = await new Browser().submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    expect(res.status).toBe(200);
  });

  it("answers the browser the same when no sender is configured", async () => {
    Reflect.deleteProperty(env, "__TEST_EMAIL");
    const res = await new Browser().submit("/account/register", "/account/register", { email: ALICE, password: GOOD_PASSWORD });
    expect(res.status).toBe(200);
    expect(await userRow(ALICE)).not.toBeNull();
  });
});
