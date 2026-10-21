import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { LOG_URL_TTL_SECONDS, parseLogKeys, signLogUrl, verifyLogSig } from "../../src/logs/sign";

const NOW = 1_767_225_600_000;
const saved = env.LOG_SIGNING_KEYS;

function key(fill: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
}

function parts(url: string): { path: string; exp: number; sig: string } {
  const u = new URL(url);
  return { path: u.pathname, exp: Number(u.searchParams.get("exp")), sig: u.searchParams.get("sig") ?? "" };
}

afterEach(() => {
  env.LOG_SIGNING_KEYS = saved;
});

describe("signLogUrl and verifyLogSig", () => {
  it("signs a link on the hub origin that the current key verifies for 15 minutes", async () => {
    env.LOG_SIGNING_KEYS = JSON.stringify({ "1": key(1) });
    const url = await signLogUrl(env, "run_1", "test", NOW);
    expect(url.startsWith(`${env.HUB_ORIGIN}/logs/run_1/test?exp=`)).toBe(true);
    const { exp, sig } = parts(url);
    expect(exp).toBe(NOW / 1000 + LOG_URL_TTL_SECONDS);
    expect(await verifyLogSig(env, "run_1", "test", exp, sig, NOW)).toBe(true);
  });

  it("verifies a link signed with the previous key after rotation", async () => {
    env.LOG_SIGNING_KEYS = JSON.stringify({ "1": key(1) });
    const { exp, sig } = parts(await signLogUrl(env, "run_1", "test", NOW));
    env.LOG_SIGNING_KEYS = JSON.stringify({ "1": key(1), "2": key(2) });
    expect(await verifyLogSig(env, "run_1", "test", exp, sig, NOW)).toBe(true);
    expect(parts(await signLogUrl(env, "run_1", "test", NOW)).sig).not.toBe(sig);
  });

  it("refuses a link signed with a key no longer in the list", async () => {
    env.LOG_SIGNING_KEYS = JSON.stringify({ "1": key(1) });
    const { exp, sig } = parts(await signLogUrl(env, "run_1", "test", NOW));
    env.LOG_SIGNING_KEYS = JSON.stringify({ "2": key(2), "3": key(3) });
    expect(await verifyLogSig(env, "run_1", "test", exp, sig, NOW)).toBe(false);
  });

  it("refuses a link once exp has passed", async () => {
    const { exp, sig } = parts(await signLogUrl(env, "run_1", "test", NOW));
    expect(await verifyLogSig(env, "run_1", "test", exp, sig, NOW + LOG_URL_TTL_SECONDS * 1000 - 1)).toBe(true);
    expect(await verifyLogSig(env, "run_1", "test", exp, sig, NOW + LOG_URL_TTL_SECONDS * 1000)).toBe(false);
  });

  it("refuses a link whose job, run or exp was changed", async () => {
    const { exp, sig } = parts(await signLogUrl(env, "run_1", "test", NOW));
    expect(await verifyLogSig(env, "run_1", "deploy", exp, sig, NOW)).toBe(false);
    expect(await verifyLogSig(env, "run_2", "test", exp, sig, NOW)).toBe(false);
    expect(await verifyLogSig(env, "run_1", "test", exp + 60, sig, NOW)).toBe(false);
  });

  it("refuses to sign a job name that is not a path segment", async () => {
    await expect(signLogUrl(env, "run_1", "../x", NOW)).rejects.toMatchObject({ code: "bad_job_name", status: 400 });
  });
});

describe("parseLogKeys", () => {
  it("orders keys newest version first", () => {
    expect(parseLogKeys(JSON.stringify({ "2": key(2), "10": key(10), "1": key(1) })).map((k) => k[0])).toEqual([10, 2, 1]);
  });

  it.each([
    ["not JSON", "1,2"],
    ["an array", JSON.stringify([key(1)])],
    ["no keys", "{}"],
    ["a version that is not a positive integer", JSON.stringify({ current: key(1) })],
    ["a key under 32 bytes", JSON.stringify({ "1": btoa("short") })],
  ])("throws log_keys_invalid for %s", (_name, raw) => {
    expect(() => parseLogKeys(raw)).toThrow(expect.objectContaining({ code: "log_keys_invalid", status: 500 }));
  });
});
