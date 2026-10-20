import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { LOG_URL_TTL_SEC, type LogRef, signLogUrl, verifyLogUrl } from "../../src/logs/signing";

const REF: LogRef = { installationId: 41, runId: "run_sign_1", job: "test" };
const NOW = new Date("2026-03-01T12:00:00Z");
const OLD_KEY = "log-signing-key-before-rotation";

const original = { key: env.LOG_SIGNING_KEY, previous: env.LOG_SIGNING_KEY_PREVIOUS };

afterEach(() => {
  env.LOG_SIGNING_KEY = original.key;
  if (original.previous === undefined) delete env.LOG_SIGNING_KEY_PREVIOUS;
  else env.LOG_SIGNING_KEY_PREVIOUS = original.previous;
});

async function signedParams(ref: LogRef = REF, ttlSec?: number): Promise<URLSearchParams> {
  return new URL(await signLogUrl(env, ref, NOW, ttlSec)).searchParams;
}

const after = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

describe("signLogUrl", () => {
  it("links to the hub's log view with i, r, j, exp, kid=c and sig", async () => {
    const url = new URL(await signLogUrl(env, REF, NOW));
    expect(`${url.origin}${url.pathname}`).toBe(`${env.HUB_ORIGIN}/logs/view`);
    expect([...url.searchParams.keys()]).toEqual(["i", "r", "j", "exp", "kid", "sig"]);
    expect(url.searchParams.get("i")).toBe("41");
    expect(url.searchParams.get("exp")).toBe(String(NOW.getTime() / 1000 + LOG_URL_TTL_SEC));
    expect(url.searchParams.get("kid")).toBe("c");
    expect(url.searchParams.get("sig")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses a job name no log can have", async () => {
    await expect(signLogUrl(env, { ...REF, job: "../x" }, NOW)).rejects.toMatchObject({ code: "bad_job_name", status: 400 });
  });
});

describe("verifyLogUrl", () => {
  it("returns the ref of a link it signed", async () => {
    expect(await verifyLogUrl(env, await signedParams(), NOW)).toEqual({ ok: true, ref: REF });
    expect(await verifyLogUrl(env, await signedParams(), after(LOG_URL_TTL_SEC - 1))).toEqual({ ok: true, ref: REF });
  });

  it.each([
    ["i", "42"],
    ["r", "run_sign_2"],
    ["j", "deploy"],
  ])("answers bad_signature when %s is changed", async (name, value) => {
    const params = await signedParams();
    params.set(name, value);
    expect(await verifyLogUrl(env, params, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("answers expired 901 seconds after signing", async () => {
    expect(await verifyLogUrl(env, await signedParams(), after(901))).toEqual({ ok: false, reason: "expired" });
  });

  it("answers malformed to a validly signed exp two hours ahead", async () => {
    expect(await verifyLogUrl(env, await signedParams(REF, 7200), NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it.each(["i", "r", "j", "exp", "kid", "sig"])("answers malformed when %s is missing", async (name) => {
    const params = await signedParams();
    params.delete(name);
    expect(await verifyLogUrl(env, params, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([
    ["exp", "soon"],
    ["exp", "1e3"],
    ["i", "4x"],
    ["kid", "q"],
  ])("answers malformed when %s is %s", async (name, value) => {
    const params = await signedParams();
    params.set(name, value);
    expect(await verifyLogUrl(env, params, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("verifies kid=p under LOG_SIGNING_KEY_PREVIOUS and refuses it once that key is unset", async () => {
    env.LOG_SIGNING_KEY = OLD_KEY;
    const params = await signedParams();
    env.LOG_SIGNING_KEY = original.key;
    params.set("kid", "p");

    env.LOG_SIGNING_KEY_PREVIOUS = OLD_KEY;
    expect(await verifyLogUrl(env, params, NOW)).toEqual({ ok: true, ref: REF });

    delete env.LOG_SIGNING_KEY_PREVIOUS;
    expect(await verifyLogUrl(env, params, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("does not take a kid=p signature under the current key", async () => {
    const params = await signedParams();
    params.set("kid", "p");
    env.LOG_SIGNING_KEY_PREVIOUS = OLD_KEY;
    expect(await verifyLogUrl(env, params, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });
});
