import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createSinkConfig,
  disableSinkConfig,
  getSinkConfigWithSecret,
  getSinkMessage,
  listSinkConfigs,
  putSinkMessage,
  recordDelivery,
} from "../../src/db/sinks";
import { tenantDb } from "../../src/db/tenant";
import { testClock } from "../clock";
import { clearTables } from "./helpers";

const SECRET = "123456:telegram-bot-token-plaintext";
const t = tenantDb(env.DB, 7);

beforeEach(clearTables);

function telegram(repo = "org7/api") {
  return { kind: "telegram" as const, repo, target: "-100200300", secret: SECRET, createdBy: "slack:T1:U1" };
}

describe("sink configs", () => {
  it("lists created configs of a repo, oldest first, without their secret", async () => {
    const first = await createSinkConfig(env, t, telegram());
    testClock.advance(1);
    const second = await createSinkConfig(env, t, { kind: "webhook", repo: "org7/api", target: "https://hooks.example/ci", secret: null, createdBy: "agent:agt_1" });
    await createSinkConfig(env, t, telegram("org7/web"));

    expect(first.id).toMatch(/^snk_[0-9a-hjkmnp-tv-z]{26}$/);
    const listed = await listSinkConfigs(t, "org7/api");
    expect(listed).toEqual([first, second]);
    for (const cfg of listed) expect(cfg).not.toHaveProperty("secret");
    expect(await listSinkConfigs(t)).toHaveLength(3);
  });

  it("decrypts the secret round-trip, and stores none for a sink without one", async () => {
    const cfg = await createSinkConfig(env, t, telegram());
    const hook = await createSinkConfig(env, t, { kind: "webhook", repo: "org7/api", target: "https://hooks.example/ci", secret: null, createdBy: "agent:agt_1" });

    expect(await getSinkConfigWithSecret(env, t, cfg.id)).toEqual({ ...cfg, secret: SECRET });
    expect(await getSinkConfigWithSecret(env, t, hook.id)).toEqual({ ...hook, secret: null });
    expect(await getSinkConfigWithSecret(env, t, "snk_missing")).toBeNull();
  });

  it("hides a disabled config from the list but still reads it with its reason", async () => {
    const cfg = await createSinkConfig(env, t, telegram());

    expect(await disableSinkConfig(t, cfg.id, "telegram_unauthorized", 1234)).toBe(true);
    expect(await disableSinkConfig(t, cfg.id, "again", 5678)).toBe(false);

    expect(await listSinkConfigs(t, "org7/api")).toEqual([]);
    expect(await getSinkConfigWithSecret(env, t, cfg.id)).toMatchObject({ disabledAt: 1234, disabledReason: "telegram_unauthorized", secret: SECRET });
  });

  it("never stores the secret in plaintext", async () => {
    const cfg = await createSinkConfig(env, t, telegram());
    const row = await env.DB.prepare("SELECT secret_enc, key_version FROM sink_configs WHERE id = ?1").bind(cfg.id).first<{ secret_enc: number[]; key_version: number }>();

    const hex = (bytes: Iterable<number>) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const stored = hex(row?.secret_enc ?? []);
    expect(stored.length / 2).toBeGreaterThan(SECRET.length);
    expect(stored).not.toContain(hex(new TextEncoder().encode(SECRET)));
    expect(stored).not.toContain(hex(new TextEncoder().encode("telegram-bot-token")));
    expect(row?.key_version).toEqual(expect.any(Number));
  });
});

describe("sink messages and deliveries", () => {
  it("keeps the latest message of a run per sink", async () => {
    expect(await getSinkMessage(t, "snk_1", "trg_1")).toBeNull();
    await putSinkMessage(t, "snk_1", "trg_1", { externalId: "42", lastHash: "a" }, 1);
    await putSinkMessage(t, "snk_1", "trg_1", { externalId: "42", lastHash: "b" }, 2);

    expect(await getSinkMessage(t, "snk_1", "trg_1")).toEqual({ externalId: "42", lastHash: "b" });
    expect(await getSinkMessage(t, "snk_2", "trg_1")).toBeNull();
  });

  it("records each attempt once", async () => {
    const attempt = { sinkId: "snk_1", deliveryId: "dlv_1", runId: "trg_1", attempt: 1, status: "retrying" as const, httpStatus: 503, at: 1 };
    await recordDelivery(t, attempt);
    await recordDelivery(t, { ...attempt, status: "ok", httpStatus: null });
    await recordDelivery(t, { ...attempt, attempt: 2, status: "ok", httpStatus: null, at: 2 });

    const { results } = await env.DB.prepare("SELECT attempt, status, http_status FROM sink_deliveries ORDER BY attempt").all();
    expect(results).toEqual([
      { attempt: 1, status: "retrying", http_status: 503 },
      { attempt: 2, status: "ok", http_status: null },
    ]);
  });
});
