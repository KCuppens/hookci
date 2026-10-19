import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEncKeys } from "../src/crypto";
import { runCron } from "../src/cron";
import { reencryptTokens } from "../src/cron/reencrypt";
import { getWorkspace } from "../src/db/workspaces";
import { getBotToken, storeWorkspace } from "../src/slack/tokens";
import { clearTables } from "./db/helpers";

const TOKENS: Record<string, string> = {
  T0001: "xoxb-1-first-workspace-token",
  T0002: "xoxb-2-second-workspace-token",
  T0003: "xoxb-3-third-workspace-token",
};

const savedKeys = env.TOKEN_ENC_KEYS;
const key1 = parseEncKeys(savedKeys).keys["1"] ?? "";
const key2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));

async function seedOnKey1(): Promise<void> {
  env.TOKEN_ENC_KEYS = JSON.stringify({ current: 1, keys: { "1": key1 } });
  for (const [teamId, botToken] of Object.entries(TOKENS)) {
    await storeWorkspace(
      env,
      { teamId, teamName: teamId, enterpriseId: null, isEnterpriseInstall: false, botUserId: "U0BOT", botToken, scope: "", authedUserId: "U0ADMIN" },
      "U0ADMIN",
    );
  }
  env.TOKEN_ENC_KEYS = JSON.stringify({ current: 2, keys: { "1": key1, "2": key2 } });
}

async function versions(): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare("SELECT team_id, key_version FROM workspaces ORDER BY team_id").all<{ team_id: string; key_version: number }>();
  return Object.fromEntries(results.map((r) => [r.team_id, r.key_version]));
}

beforeEach(async () => {
  await clearTables();
  await seedOnKey1();
});

afterEach(() => {
  env.TOKEN_ENC_KEYS = savedKeys;
  vi.restoreAllMocks();
});

describe("reencryptTokens", () => {
  it("moves every row from key 1 to the current key 2 in one cron pass", async () => {
    const log = vi.spyOn(console, "log");
    expect(await versions()).toEqual({ T0001: 1, T0002: 1, T0003: 1 });

    await runCron(env, "*/5 * * * *");

    expect(await versions()).toEqual({ T0001: 2, T0002: 2, T0003: 2 });
    for (const [teamId, token] of Object.entries(TOKENS)) expect(await getBotToken(env, teamId)).toBe(token);
    expect(log.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"event":"reencrypt"'));
    expect(log.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"count":3'));
  });

  it("moves at most limit rows per pass and returns how many it moved", async () => {
    expect(await reencryptTokens(env, 2)).toBe(2);
    expect(Object.values(await versions()).sort()).toEqual([1, 2, 2]);
    expect(await reencryptTokens(env, 2)).toBe(1);
    expect(await reencryptTokens(env, 2)).toBe(0);
    expect(await versions()).toEqual({ T0001: 2, T0002: 2, T0003: 2 });
  });

  it("skips a row it cannot decrypt and still moves the rest", async () => {
    const broken = await getWorkspace(env.DB, "T0002");
    const ct = broken?.bot_token_ct.slice() ?? new Uint8Array();
    ct[ct.length - 1] = (ct[ct.length - 1] ?? 0) ^ 0x01;
    await env.DB.prepare("UPDATE workspaces SET bot_token_ct = ?1 WHERE team_id = 'T0002'").bind(ct).run();
    const errors = vi.spyOn(console, "error");

    expect(await reencryptTokens(env)).toBe(2);

    expect(await versions()).toEqual({ T0001: 2, T0002: 1, T0003: 2 });
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("T0002"));
  });
});
