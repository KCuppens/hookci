import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEncKeys } from "../src/crypto";
import { runCron } from "../src/cron";
import { reencryptSinkSecrets, reencryptTokens } from "../src/cron/reencrypt";
import { createSinkConfig, getSinkConfigWithSecret, type SinkConfigRow } from "../src/db/sinks";
import { tenantDb } from "../src/db/tenant";
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
    expect(await reencryptTokens(env, 0, 2)).toBe(2);
    expect(Object.values(await versions()).sort()).toEqual([1, 2, 2]);
    expect(await reencryptTokens(env, 0, 2)).toBe(1);
    expect(await reencryptTokens(env, 0, 2)).toBe(0);
    expect(await versions()).toEqual({ T0001: 2, T0002: 2, T0003: 2 });
  });

  it("does not let rows that keep failing hold back the rows after them", async () => {
    const broken = await getWorkspace(env.DB, "T0001");
    const ct = broken?.bot_token_ct?.slice() ?? new Uint8Array();
    ct[ct.length - 1] = (ct[ct.length - 1] ?? 0) ^ 0x01;
    await env.DB.prepare("UPDATE workspaces SET bot_token_ct = ?1 WHERE team_id = 'T0001'").bind(ct).run();
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (let pass = 0; pass < 3; pass++) await reencryptTokens(env, 0, 1);

    expect(await versions()).toEqual({ T0001: 1, T0002: 2, T0003: 2 });
  });

  it("skips a row it cannot decrypt and still moves the rest", async () => {
    const broken = await getWorkspace(env.DB, "T0002");
    const ct = broken?.bot_token_ct?.slice() ?? new Uint8Array();
    ct[ct.length - 1] = (ct[ct.length - 1] ?? 0) ^ 0x01;
    await env.DB.prepare("UPDATE workspaces SET bot_token_ct = ?1 WHERE team_id = 'T0002'").bind(ct).run();
    const errors = vi.spyOn(console, "error");

    expect(await reencryptTokens(env, 0)).toBe(2);

    expect(await versions()).toEqual({ T0001: 2, T0002: 1, T0003: 2 });
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("T0002"));
  });
});

describe("reencryptSinkSecrets", () => {
  const SECRETS: Record<number, string> = { 7: "telegram-bot-token-7", 8: "webhook-secret-8" };
  let configs: { installationId: number; cfg: SinkConfigRow }[];

  async function sinkVersions(): Promise<(number | null)[]> {
    const { results } = await env.DB.prepare("SELECT key_version FROM sink_configs ORDER BY installation_id, id").all<{ key_version: number | null }>();
    return results.map((r) => r.key_version);
  }

  beforeEach(async () => {
    env.TOKEN_ENC_KEYS = JSON.stringify({ current: 1, keys: { "1": key1 } });
    configs = [];
    for (const [installationId, secret] of Object.entries(SECRETS).map(([id, s]) => [Number(id), s] as const)) {
      const cfg = await createSinkConfig(env, tenantDb(env.DB, installationId), { kind: "webhook", repo: "org/api", target: "https://hooks.example/ci", secret, createdBy: "slack:T1:U1" });
      configs.push({ installationId, cfg });
    }
    await createSinkConfig(env, tenantDb(env.DB, 9), { kind: "webhook", repo: "org/api", target: "https://hooks.example/ci", secret: null, createdBy: "slack:T1:U1" });
    env.TOKEN_ENC_KEYS = JSON.stringify({ current: 2, keys: { "1": key1, "2": key2 } });
  });

  it("moves every secret to the current key in one cron pass, so the old key can be dropped", async () => {
    expect(await sinkVersions()).toEqual([1, 1, null]);

    await runCron(env, "*/5 * * * *");

    expect(await sinkVersions()).toEqual([2, 2, null]);
    env.TOKEN_ENC_KEYS = JSON.stringify({ current: 2, keys: { "2": key2 } });
    for (const { installationId, cfg } of configs) {
      expect((await getSinkConfigWithSecret(env, tenantDb(env.DB, installationId), cfg.id))?.secret).toBe(SECRETS[installationId]);
    }
  });

  it("moves at most limit secrets per pass, continuing where the last pass ended", async () => {
    expect(await reencryptSinkSecrets(env, 0, 1)).toBe(1);
    expect(await sinkVersions()).toEqual([2, 1, null]);
    expect(await reencryptSinkSecrets(env, 0, 1)).toBe(1);
    expect(await reencryptSinkSecrets(env, 0, 1)).toBe(0);
    expect(await sinkVersions()).toEqual([2, 2, null]);
  });

  it("skips a secret it cannot decrypt and still moves the rest", async () => {
    const [broken, kept] = configs;
    await env.DB.prepare("UPDATE sink_configs SET secret_enc = (SELECT secret_enc FROM sink_configs WHERE installation_id = ?1) WHERE installation_id = ?2")
      .bind(kept?.installationId, broken?.installationId)
      .run();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await reencryptSinkSecrets(env, 0)).toBe(1);

    expect(await sinkVersions()).toEqual([1, 2, null]);
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining(broken?.cfg.id ?? "missing"));
  });
});
