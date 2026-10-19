import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { HubError } from "../src/errors";
import { consumeState, issueSession, issueState, readSession, STATE_COOKIE } from "../src/oauth/state";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";

/** The Cookie request header a browser sends back for a Set-Cookie value. */
function cookieHeader(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

async function expectInvalid(attempt: Promise<unknown>): Promise<void> {
  await expect(attempt).rejects.toBeInstanceOf(HubError);
  await expect(attempt).rejects.toMatchObject({ code: "oauth_state_invalid", status: 400 });
}

beforeEach(async () => {
  await clearTables();
});

describe("oauth state", () => {
  it("issues a __Host- cookie bound to the state and returns the payload once", async () => {
    const issued = await issueState(env, "github_install", { from: "start" }, testClock.now());
    expect(issued.cookie).toMatch(new RegExp(`^${STATE_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$`));
    expect(issued.state.split(".")[0]).toBe(cookieHeader(issued.cookie).split("=")[1]);

    expect(await consumeState(env, "github_install", issued.state, cookieHeader(issued.cookie), testClock.now())).toEqual({ from: "start" });
    await expectInvalid(consumeState(env, "github_install", issued.state, cookieHeader(issued.cookie), testClock.now()));
  });

  it("rejects a state older than 600 s", async () => {
    const issued = await issueState(env, "github_install", {}, testClock.now());
    testClock.advance(600_001);
    await expectInvalid(consumeState(env, "github_install", issued.state, cookieHeader(issued.cookie), testClock.now()));
  });

  it("rejects a tampered signature", async () => {
    const issued = await issueState(env, "github_install", {}, testClock.now());
    const [nonce, sig = ""] = issued.state.split(".");
    const tampered = `${nonce}.${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`;
    await expectInvalid(consumeState(env, "github_install", tampered, cookieHeader(issued.cookie), testClock.now()));
    // The real state still works: the failed attempt did not consume it.
    expect(await consumeState(env, "github_install", issued.state, cookieHeader(issued.cookie), testClock.now())).toEqual({});
  });

  it("rejects a state whose cookie holds another nonce, or no cookie", async () => {
    const mine = await issueState(env, "github_install", {}, testClock.now());
    const other = await issueState(env, "github_install", {}, testClock.now());
    await expectInvalid(consumeState(env, "github_install", mine.state, cookieHeader(other.cookie), testClock.now()));
    await expectInvalid(consumeState(env, "github_install", mine.state, null, testClock.now()));
  });

  it("rejects a github_install state presented as slack_install", async () => {
    const issued = await issueState(env, "github_install", {}, testClock.now());
    await expectInvalid(consumeState(env, "slack_install", issued.state, cookieHeader(issued.cookie), testClock.now()));
  });
});

describe("session cookie", () => {
  it("covers only its installations, for 30 minutes, and only with a valid signature", async () => {
    const setCookie = await issueSession(env, { installationIds: [42, 43], githubUserId: 7 }, testClock.now());
    expect(setCookie).toMatch(/^__Host-zeroci_session=42-43\.7\.\d+\.[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800$/);
    const header = cookieHeader(setCookie);

    expect(await readSession(env, header, 43, testClock.now())).toEqual({ installationIds: [42, 43], githubUserId: 7 });
    expect(await readSession(env, header, 44, testClock.now())).toBeNull();
    expect(await readSession(env, header.replace("42-43", "42-44"), 44, testClock.now())).toBeNull();
    expect(await readSession(env, null, 42, testClock.now())).toBeNull();

    testClock.advance(30 * 60_000 + 1);
    expect(await readSession(env, header, 42, testClock.now())).toBeNull();
  });
});
