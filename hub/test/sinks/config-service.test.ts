import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertRepos } from "../../src/db/repos";
import { type TenantDb, tenantDb } from "../../src/db/tenant";
import type { Clock } from "../../src/do/clock";
import {
  addSinkConfig,
  listSinkConfigsForRepo,
  MAX_SINKS_PER_REPO,
  removeSinkConfig,
  type SinkActor,
  SinkConfigError,
  sendTestDelivery,
} from "../../src/sinks/config-service";
import { signWebhook } from "../../src/sinks/webhook";
import { clearTables } from "../db/helpers";
import { seedTenant, type Tenant } from "../helpers/tenants";

const TG_API = "https://tg.test";
const BOT_TOKEN = "123456:AAH-secret_bot_token";
const CHAT = "-1001234567890";
const HOOK = "https://hooks.example.com/services/zeroci-builds-and-deploys?token=q";

interface Sent {
  url: string;
  init: RequestInit;
}

let a: Tenant;
let b: Tenant;
let ta: TenantDb;
let tb: TenantDb;
let actor: SinkActor;
let sent: Sent[];
let answer: (url: string) => Response;
const clock: Clock = { now: () => at };
let at = 0;
const saved = { fetcher: env.__TEST_FETCHER, clock: env.__TEST_CLOCK, base: env.TELEGRAM_API_BASE };

const telegramOk = (url: string): Response =>
  url.endsWith("/getMe")
    ? Response.json({ ok: true, result: { id: 123456, is_bot: true, username: "acme_ci_bot" } })
    : Response.json({ ok: true, result: { id: Number(CHAT), type: "supergroup", title: "Acme CI", message_id: 7 } });

beforeEach(async () => {
  await clearTables();
  a = await seedTenant(env, { installationId: 71, teamId: "T071" });
  b = await seedTenant(env, { installationId: 72, teamId: "T072" });
  ta = tenantDb(env.DB, a.installationId);
  tb = tenantDb(env.DB, b.installationId);
  actor = { type: "agent", id: a.agentId };
  at = Date.now();
  sent = [];
  answer = telegramOk;
  env.__TEST_CLOCK = clock;
  env.TELEGRAM_API_BASE = TG_API;
  env.__TEST_FETCHER = async (input, init) => {
    sent.push({ url: String(input), init: init ?? {} });
    return answer(String(input));
  };
});

afterEach(() => {
  env.__TEST_FETCHER = saved.fetcher;
  env.__TEST_CLOCK = saved.clock;
  env.TELEGRAM_API_BASE = saved.base;
  vi.restoreAllMocks();
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SinkConfigError);
  return (err as SinkConfigError).code;
}

async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

describe("addSinkConfig", () => {
  it("stores a Telegram config with the bot token encrypted", async () => {
    const { sink, generatedSecret } = await addSinkConfig(env, ta, actor, { kind: "telegram", repo: a.fullName.toUpperCase(), botToken: BOT_TOKEN, chatId: CHAT, label: " ops " });
    expect(generatedSecret).toBeUndefined();
    expect(sink).toMatchObject({ kind: "telegram", repo: a.fullName, label: "ops", target: `chat ${CHAT}`, disabled_at: null, last_error: null });
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual([`/bot${BOT_TOKEN}/getMe`, `/bot${BOT_TOKEN}/getChat`]);
    const row = await env.DB.prepare("SELECT * FROM sink_configs WHERE id = ?1").bind(sink.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ installation_id: a.installationId, created_by: `agent:${a.agentId}` });
    expect(JSON.stringify(row)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(row)).not.toContain("secret_bot_token");
  });

  it("returns a webhook's generated secret once and never lists it", async () => {
    const { sink, generatedSecret } = await addSinkConfig(env, ta, actor, { kind: "webhook", repo: a.fullName, url: HOOK });
    expect(generatedSecret).toMatch(/^zcwh_/);
    expect(sink.target).toBe("https://hooks.example.com/services/zeroci-builds-...");
    const listed = await listSinkConfigsForRepo(ta, a.fullName);
    expect(listed).toEqual([sink]);
    expect(JSON.stringify(listed)).not.toContain(generatedSecret!);
    const row = await env.DB.prepare("SELECT * FROM sink_configs WHERE id = ?1").bind(sink.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(generatedSecret!);
    expect(sent).toEqual([]);
  });

  it("refuses the eleventh config of a repo, disabled ones counted", async () => {
    for (let i = 0; i < MAX_SINKS_PER_REPO; i++) {
      await addSinkConfig(env, ta, actor, { kind: "webhook", repo: a.fullName, url: `https://hooks.example.com/${i}` });
    }
    await env.DB.prepare("UPDATE sink_configs SET disabled_at = 1, disabled_reason = 'x'").run();
    expect(await refusal(addSinkConfig(env, ta, actor, { kind: "webhook", repo: a.fullName, url: "https://hooks.example.com/11" }))).toBe("limit_reached");
  });

  it("refuses a repo the installation has not bound, and one written wrong", async () => {
    await upsertRepos(ta, [{ repo_id: 7101, full_name: "org71/unbound", default_branch: "main" }]);
    expect(await refusal(addSinkConfig(env, ta, actor, { kind: "webhook", repo: "org71/unbound", url: HOOK }))).toBe("repo_not_bound");
    expect(await refusal(addSinkConfig(env, ta, actor, { kind: "webhook", repo: b.fullName, url: HOOK }))).toBe("repo_not_bound");
    expect(await refusal(addSinkConfig(env, ta, actor, { kind: "webhook", repo: "not a repo", url: HOOK }))).toBe("invalid_repo");
  });

  it.each([
    ["http://hooks.example.com/x", "not_https"],
    ["https://10.0.0.1/x", "private_host"],
    ["https://ci.webuno.io/x", "self"],
  ])("refuses the webhook URL %s as %s", async (url, code) => {
    expect(await refusal(addSinkConfig(env, ta, actor, { kind: "webhook", repo: a.fullName, url }))).toBe(code);
    expect(await count("sink_configs")).toBe(0);
  });

  it("maps getMe 401 to bad_token and getChat 400 to chat_unreachable", async () => {
    answer = () => Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
    expect(await refusal(addSinkConfig(env, ta, actor, { kind: "telegram", repo: a.fullName, botToken: BOT_TOKEN, chatId: CHAT }))).toBe("bad_token");
    answer = (url) => (url.endsWith("/getChat") ? Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 }) : telegramOk(url));
    expect(await refusal(addSinkConfig(env, ta, actor, { kind: "telegram", repo: a.fullName, botToken: BOT_TOKEN, chatId: CHAT }))).toBe("chat_unreachable");
    expect(await count("sink_configs")).toBe(0);
  });

  it("refuses a malformed bot token before calling Telegram", async () => {
    expect(await refusal(addSinkConfig(env, ta, actor, { kind: "telegram", repo: a.fullName, botToken: "../getUpdates", chatId: CHAT }))).toBe("bad_token");
    expect(sent).toEqual([]);
  });
});

describe("tenant isolation", () => {
  it("keeps one installation's configs from another's list, remove and test", async () => {
    const { sink } = await addSinkConfig(env, ta, actor, { kind: "webhook", repo: a.fullName, url: HOOK });
    const bActor: SinkActor = { type: "agent", id: b.agentId };
    expect(await listSinkConfigsForRepo(tb, a.fullName)).toEqual([]);
    expect(await removeSinkConfig(env, tb, bActor, sink.id)).toBe(false);
    await expect(sendTestDelivery(env, tb, bActor, sink.id)).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(sent).toEqual([]);
    expect(await listSinkConfigsForRepo(ta, a.fullName)).toEqual([sink]);
  });
});

describe("removeSinkConfig", () => {
  it("deletes the config and its messages", async () => {
    const { sink } = await addSinkConfig(env, ta, actor, { kind: "webhook", repo: a.fullName, url: HOOK });
    await env.DB.prepare("INSERT INTO sink_messages (installation_id, sink_id, run_id, external_id, last_hash, updated_at) VALUES (?1, ?2, 'run_x', NULL, 'success', 1)")
      .bind(a.installationId, sink.id)
      .run();
    expect(await removeSinkConfig(env, ta, actor, sink.id)).toBe(true);
    expect(await count("sink_configs")).toBe(0);
    expect(await count("sink_messages")).toBe(0);
    expect(await removeSinkConfig(env, ta, actor, sink.id)).toBe(false);
  });
});

describe("sendTestDelivery", () => {
  it("makes one signed POST and writes no messages or deliveries", async () => {
    const { sink, generatedSecret } = await addSinkConfig(env, ta, actor, { kind: "webhook", repo: a.fullName, url: HOOK });
    answer = () => new Response(null, { status: 204 });
    expect(await sendTestDelivery(env, ta, actor, sink.id)).toEqual({ kind: "ok" });
    expect(sent).toHaveLength(1);
    const [post] = sent;
    expect(post!.url).toBe(HOOK);
    const headers = new Headers(post!.init.headers);
    const body = String(post!.init.body);
    expect(headers.get("X-ZeroCI-Signature")).toBe(await signWebhook(generatedSecret!, Number(headers.get("X-ZeroCI-Timestamp")), body));
    expect(JSON.parse(body)).toMatchObject({ run: { repo: a.fullName, sha: "0".repeat(40), state: "success", terminal: true } });
    expect(await count("sink_messages")).toBe(0);
    expect(await count("sink_deliveries")).toBe(0);
  });

  it("sends a Telegram test as a new message every time", async () => {
    const { sink } = await addSinkConfig(env, ta, actor, { kind: "telegram", repo: a.fullName, botToken: BOT_TOKEN, chatId: CHAT });
    sent = [];
    expect(await sendTestDelivery(env, ta, actor, sink.id)).toEqual({ kind: "ok", externalId: "7" });
    expect(await sendTestDelivery(env, ta, actor, sink.id)).toEqual({ kind: "ok", externalId: "7" });
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual([`/bot${BOT_TOKEN}/sendMessage`, `/bot${BOT_TOKEN}/sendMessage`]);
    expect(await count("sink_messages")).toBe(0);
  });
});

describe("audit", () => {
  it("logs add, test and remove without the token or secret", async () => {
    const log = vi.spyOn(console, "log");
    const tg = await addSinkConfig(env, ta, actor, { kind: "telegram", repo: a.fullName, botToken: BOT_TOKEN, chatId: CHAT });
    const hook = await addSinkConfig(env, ta, actor, { kind: "webhook", repo: a.fullName, url: HOOK });
    await sendTestDelivery(env, ta, actor, hook.sink.id);
    await removeSinkConfig(env, ta, actor, tg.sink.id);

    const lines = log.mock.calls.map((call) => call.map(String).join(" "));
    const events = lines.filter((line) => line.includes('"event":"sink_config.')).map((line) => JSON.parse(line) as Record<string, unknown>);
    const who = { installation_id: a.installationId, repo: a.fullName, actor: `agent:${a.agentId}` };
    expect(events).toEqual([
      expect.objectContaining({ event: "sink_config.added", sink_id: tg.sink.id, kind: "telegram", ...who }),
      expect.objectContaining({ event: "sink_config.added", sink_id: hook.sink.id, kind: "webhook", ...who }),
      expect.objectContaining({ event: "sink_config.tested", sink_id: hook.sink.id, kind: "webhook", result: "ok", ...who }),
      expect.objectContaining({ event: "sink_config.removed", sink_id: tg.sink.id, kind: "telegram", ...who }),
    ]);
    const all = lines.join("\n");
    expect(all).not.toContain(BOT_TOKEN);
    expect(all).not.toContain("secret_bot_token");
    expect(all).not.toContain(hook.generatedSecret!);
  });
});
