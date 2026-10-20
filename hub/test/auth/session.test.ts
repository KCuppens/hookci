import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { issueSession, readSession, SESSION_COOKIE, SESSION_TTL_SEC } from "../../src/auth/session";
import { base64url } from "../../src/crypto";

const NOW = 1_700_000_000_000;
const USER = { githubUserId: 7001, login: "octocat" };

/** The cookie a browser sends back for a Set-Cookie value. */
function cookieOf(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

function requestWith(cookie: string): Request {
  return new Request("https://hub.test/runs/run_1/logs?job=test", { headers: { cookie } });
}

describe("hci_session", () => {
  it("is an HttpOnly, Secure, SameSite=Lax cookie that lasts 8 hours", async () => {
    const setCookie = await issueSession(env, USER, NOW);
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=sess1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800$`));
  });

  it("reads back the user it was issued for, among other cookies", async () => {
    const cookie = cookieOf(await issueSession(env, USER, NOW));
    expect(await readSession(env, requestWith(`theme=dark; ${cookie}`), NOW + 1000)).toEqual({ ...USER, exp: NOW / 1000 + SESSION_TTL_SEC });
  });

  it("is refused once 8 hours have passed", async () => {
    const cookie = cookieOf(await issueSession(env, USER, NOW));
    expect(await readSession(env, requestWith(cookie), NOW + SESSION_TTL_SEC * 1000 - 1)).not.toBeNull();
    expect(await readSession(env, requestWith(cookie), NOW + SESSION_TTL_SEC * 1000)).toBeNull();
  });

  it("is refused when its payload or signature is altered", async () => {
    const [name, value] = cookieOf(await issueSession(env, USER, NOW)).split("=");
    const [version, payload, signature] = (value ?? "").split(".");
    const otherUser = base64url(new TextEncoder().encode(JSON.stringify({ githubUserId: 1, login: "mallory", exp: NOW / 1000 + SESSION_TTL_SEC })));
    const flipped = `${signature?.[0] === "A" ? "B" : "A"}${signature?.slice(1)}`;
    for (const forged of [`${version}.${otherUser}.${signature}`, `${version}.${payload}.${flipped}`, `${version}.${payload}`, `${version}.${payload}.${signature}.x`]) {
      expect(await readSession(env, requestWith(`${name}=${forged}`), NOW)).toBeNull();
    }
  });

  it("is refused under another version or another signing key", async () => {
    const cookie = cookieOf(await issueSession(env, USER, NOW));
    expect(await readSession(env, requestWith(cookie.replace("=sess1.", "=sess2.")), NOW)).toBeNull();
    expect(await readSession({ ...env, LOG_SIGNING_KEY: `${env.LOG_SIGNING_KEY}-rotated` }, requestWith(cookie), NOW)).toBeNull();
  });

  it("is never valid and never issued while LOG_SIGNING_KEY is empty", async () => {
    const noKey = { ...env, LOG_SIGNING_KEY: "" };
    const payload = base64url(new TextEncoder().encode(JSON.stringify({ ...USER, exp: NOW / 1000 + SESSION_TTL_SEC })));
    const base = await crypto.subtle.importKey("raw", new Uint8Array(0), "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("hookci-session-v1") },
      base,
      256,
    );
    const key = await crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const forgedMac = base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`sess1.${payload}`)));

    expect(await readSession(noKey, requestWith(`${SESSION_COOKIE}=sess1.${payload}.${forgedMac}`), NOW)).toBeNull();
    expect(await readSession(noKey, requestWith(cookieOf(await issueSession(env, USER, NOW))), NOW)).toBeNull();
    await expect(issueSession(noKey, USER, NOW)).rejects.toMatchObject({ code: "log_signing_key_missing", status: 500 });
  });

  it("is absent without the cookie", async () => {
    expect(await readSession(env, new Request("https://hub.test/"), NOW)).toBeNull();
    expect(await readSession(env, requestWith("hci_session="), NOW)).toBeNull();
  });
});
