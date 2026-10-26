import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { base64url } from "../src/crypto";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { accountEnvironment, Browser, createFakeGoogle, GOOD_PASSWORD, type GoogleProfile, HUB, registerVerified } from "./helpers/accounts";

const E = S.account.errors;
const { mailer } = accountEnvironment({ google: true });

const ALICE = "alice@example.test";
const PROFILE: GoogleProfile = { sub: "google-sub-1", email: ALICE, email_verified: true };

interface Started {
  browser: Browser;
  state: string;
  challenge: string;
  authorize: URL;
}

async function startGoogle(browser = new Browser()): Promise<Started> {
  const res = await browser.fetch("/account/google/start");
  expect(res.status).toBe(303);
  const authorize = new URL(res.headers.get("location") ?? "");
  return { browser, state: authorize.searchParams.get("state") ?? "", challenge: authorize.searchParams.get("code_challenge") ?? "", authorize };
}

function callback(browser: Browser, params: Record<string, string>): Promise<Response> {
  return browser.fetch(`/account/google/callback?${new URLSearchParams(params).toString()}`);
}

function useGoogle(profile: GoogleProfile) {
  const google = createFakeGoogle();
  google.answer(profile);
  env.__TEST_FETCHER = google.service.fetcher;
  return google;
}

async function userRow(email: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM users WHERE email_norm = ?1").bind(email).first();
}

describe("Google authorization request", () => {
  it("redirects to Google with PKCE S256, the exact redirect URI, and a state tied to this browser", async () => {
    const { authorize, browser, state, challenge } = await startGoogle();
    expect(authorize.origin + authorize.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authorize.searchParams.get("client_id")).toBe("google-client-id");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${HUB}/account/google/callback`);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toBe("openid email");
    expect(state.length).toBeGreaterThan(20);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(browser.cookie("__Host-hookci_oauth")).toBeTruthy();
    expect(authorize.toString()).not.toContain("google-client-secret");
  });

  it("uses a fresh state and verifier on every start", async () => {
    const a = await startGoogle();
    const b = await startGoogle();
    expect(a.state).not.toBe(b.state);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it("shows the Google button on the sign-in and sign-up pages when configured", async () => {
    for (const path of ["/account/login", "/account/register"]) {
      expect(await (await new Browser().fetch(path)).text()).toContain('href="/account/google/start"');
    }
  });

  it("answers 404 for the start when Google is not configured", async () => {
    delete env.GOOGLE_CLIENT_SECRET;
    const res = await new Browser().fetch("/account/google/start");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(await (await new Browser().fetch("/account/login")).text()).not.toContain("/account/google/start");
  });
});

describe("Google callback", () => {
  it("creates a verified account and signs in, sending the PKCE verifier that matches the challenge", async () => {
    const google = useGoogle(PROFILE);
    const { browser, state, challenge } = await startGoogle();
    const res = await callback(browser, { code: "auth-code", state });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/connect-github");
    expect(browser.cookie("__Host-hookci_session")).toBeTruthy();

    expect(google.tokenRequests).toHaveLength(1);
    const request = google.tokenRequests[0]!;
    expect(request.grant_type).toBe("authorization_code");
    expect(request.code).toBe("auth-code");
    expect(request.client_id).toBe("google-client-id");
    expect(request.client_secret).toBe("google-client-secret");
    expect(request.redirect_uri).toBe(`${HUB}/account/google/callback`);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.code_verifier));
    expect(base64url(new Uint8Array(digest))).toBe(challenge);

    const user = await userRow(ALICE);
    expect(user?.google_sub).toBe("google-sub-1");
    expect(user?.email_verified_at).not.toBeNull();
    expect(user?.password_hash).toBeNull();
  });

  it("refuses a state that does not match the one issued to this browser", async () => {
    const google = useGoogle(PROFILE);
    const { browser } = await startGoogle();
    const res = await callback(browser, { code: "auth-code", state: "forged-state" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(E.googleFailed);
    expect(google.tokenRequests).toHaveLength(0);
    expect(browser.cookie("__Host-hookci_session")).toBeUndefined();
    expect(await userRow(ALICE)).toBeNull();
  });

  it("refuses a valid state presented by a different browser", async () => {
    const google = useGoogle(PROFILE);
    const { state } = await startGoogle(new Browser("203.0.113.20"));
    const attacker = new Browser("203.0.113.21");
    const res = await callback(attacker, { code: "auth-code", state });
    expect(res.status).toBe(400);
    expect(google.tokenRequests).toHaveLength(0);
    expect(attacker.cookie("__Host-hookci_session")).toBeUndefined();
  });

  it("refuses a callback with no state, and one with a state but no code", async () => {
    const google = useGoogle(PROFILE);
    const browser = new Browser();
    expect((await callback(browser, { code: "auth-code" })).status).toBe(400);
    const { state } = await startGoogle(browser);
    expect((await callback(browser, { state })).status).toBe(400);
    expect(google.tokenRequests).toHaveLength(0);
  });

  it("uses a state once", async () => {
    useGoogle(PROFILE);
    const { browser, state } = await startGoogle();
    expect((await callback(browser, { code: "auth-code", state })).status).toBe(303);
    const replay = new Browser("203.0.113.22");
    const res = await callback(replay, { code: "auth-code", state });
    expect(res.status).toBe(400);
  });

  it("refuses a state that has expired", async () => {
    useGoogle(PROFILE);
    const { browser, state } = await startGoogle();
    testClock.advance(11 * 60_000);
    expect((await callback(browser, { code: "auth-code", state })).status).toBe(400);
  });

  it("refuses a GitHub flow state on the Google callback", async () => {
    useGoogle(PROFILE);
    const browser = new Browser();
    const gh = await browser.fetch("/login");
    const githubState = new URL(gh.headers.get("location") ?? "https://x.test/").searchParams.get("state") ?? "";
    const res = await callback(browser, { code: "auth-code", state: githubState });
    expect(res.status).toBe(400);
    expect(browser.cookie("__Host-hookci_session")).toBeUndefined();
  });

  it.each([
    ["false", false],
    ["the string true", "true"],
  ])("refuses an email Google does not confirm (%s)", async (_name, flag) => {
    useGoogle({ ...PROFILE, email_verified: flag });
    const { browser, state } = await startGoogle();
    const res = await callback(browser, { code: "auth-code", state });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(E.googleUnverified);
    expect(browser.cookie("__Host-hookci_session")).toBeUndefined();
    expect(await userRow(ALICE)).toBeNull();
  });

  it("refuses when Google's token endpoint fails", async () => {
    const google = createFakeGoogle();
    google.service.respond("POST", "/token", () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    env.__TEST_FETCHER = google.service.fetcher;
    const { browser, state } = await startGoogle();
    const res = await callback(browser, { code: "bad-code", state });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain(E.googleFailed);
    expect(browser.cookie("__Host-hookci_session")).toBeUndefined();
  });

  it("links to an existing account with the same verified email and does not create a second one", async () => {
    const accountId = await registerVerified(mailer, ALICE);
    useGoogle(PROFILE);
    const { browser, state } = await startGoogle();
    const res = await callback(browser, { code: "auth-code", state });
    expect(res.status).toBe(303);
    const { results } = await env.DB.prepare("SELECT id, google_sub FROM users").all<{ id: string; google_sub: string | null }>();
    expect(results).toEqual([{ id: accountId, google_sub: "google-sub-1" }]);
    // The password still works: linking does not replace it.
    const login = await new Browser("203.0.113.23").submit("/account/login", "/account/login", { email: ALICE, password: GOOD_PASSWORD });
    expect(login.status).toBe(303);
  });

  it("never merges into an account whose email is not verified", async () => {
    const squatter = new Browser("203.0.113.24");
    await squatter.submit("/account/register", "/account/register", { email: ALICE, password: "squatter pass 1" });
    useGoogle(PROFILE);
    const { browser, state } = await startGoogle();
    const res = await callback(browser, { code: "auth-code", state });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(E.googleConflict);
    expect(browser.cookie("__Host-hookci_session")).toBeUndefined();
    const user = await userRow(ALICE);
    expect(user?.google_sub).toBeNull();
    expect(user?.email_verified_at).toBeNull();
  });

  it("signs a known Google subject in even when its address changed, without touching other accounts", async () => {
    await registerVerified(mailer, "other@example.test");
    useGoogle(PROFILE);
    const first = await startGoogle();
    await callback(first.browser, { code: "auth-code", state: first.state });
    useGoogle({ ...PROFILE, email: "other@example.test" });
    const second = await startGoogle();
    const res = await callback(second.browser, { code: "auth-code", state: second.state });
    expect(res.status).toBe(303);
    const other = await userRow("other@example.test");
    expect(other?.google_sub).toBeNull();
  });

  it("does not link a second Google identity to an account that already has one", async () => {
    await registerVerified(mailer, ALICE);
    useGoogle(PROFILE);
    const first = await startGoogle();
    await callback(first.browser, { code: "auth-code", state: first.state });
    useGoogle({ ...PROFILE, sub: "google-sub-2" });
    const second = await startGoogle();
    const res = await callback(second.browser, { code: "auth-code", state: second.state });
    expect(res.status).toBe(403);
    expect((await userRow(ALICE))?.google_sub).toBe("google-sub-1");
  });
});
