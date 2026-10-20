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

describe("Linear configs", () => {
  const LIN_KEY = "lin_api_CONFIGSECRET77";
  const DANA = { id: "user_1", name: "Dana", url: "https://linear.app/acme/profiles/dana" };
  const savedUrl = env.LINEAR_API_URL;
  let queries: string[];
  let teams: unknown[];
  let users: unknown[];
  let reply: ((query: string) => Response) | null;
  const linear = (extra: { teamKey?: string; assigneeEmail?: string; label?: string } = {}) =>
    addSinkConfig(env, ta, actor, { kind: "linear", repo: a.fullName, apiKey: LIN_KEY, teamKey: "ENG", ...extra });

  beforeEach(() => {
    queries = [];
    teams = [{ id: "team_1", key: "ENG" }];
    users = [DANA];
    reply = null;
    env.LINEAR_API_URL = "https://linear.test/graphql";
    env.__TEST_FETCHER = async (_input, init) => {
      const query = String(JSON.parse(String(init?.body)).query);
      queries.push(query);
      if (reply) return reply(query);
      if (query.includes("teams(")) return Response.json({ data: { teams: { nodes: teams } } });
      if (query.includes("users(")) return Response.json({ data: { users: { nodes: users } } });
      if (query.includes("team(")) return Response.json({ data: { team: { states: { nodes: [{ id: "state_done", position: 0 }] } } } });
      return Response.json({ data: { viewer: { id: "me" } } });
    };
  });

  afterEach(() => {
    env.LINEAR_API_URL = savedUrl;
  });

  it("stores the key encrypted and lists only the team key and assignee name", async () => {
    const { sink, generatedSecret } = await linear({ assigneeEmail: "dana@acme.test", label: "deploys" });
    expect(generatedSecret).toBeUndefined();
    expect(sink).toMatchObject({ kind: "linear", label: "deploys", target: { teamKey: "ENG", assigneeName: "Dana" } });
    const row = await env.DB.prepare("SELECT * FROM sink_configs WHERE id = ?1").bind(sink.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(LIN_KEY);
    expect(JSON.parse(String(row?.target))).toEqual({
      teamId: "team_1",
      teamKey: "ENG",
      assigneeId: "user_1",
      assigneeName: "Dana",
      assigneeUrl: DANA.url,
      completedStateId: "state_done",
    });
    const listed = await listSinkConfigsForRepo(ta, a.fullName);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.kind).toBe("linear");
    expect(listed[0]?.target).toStrictEqual({ teamKey: "ENG", assigneeName: "Dana" });
    expect(JSON.stringify(listed)).not.toContain(LIN_KEY);
    expect(JSON.stringify(listed)).not.toContain("team_1");
  });

  it("lists a Linear row whose stored target does not parse with an unknown team key", async () => {
    const { sink: broken } = await linear();
    const { sink: good } = await linear({ label: "good" });
    await env.DB.prepare("UPDATE sink_configs SET target = 'not json' WHERE id = ?1").bind(broken.id).run();
    const listed = await listSinkConfigsForRepo(ta, a.fullName);
    expect(listed.find((s) => s.id === broken.id)?.target).toStrictEqual({ teamKey: "?" });
    expect(listed.find((s) => s.id === good.id)?.target).toStrictEqual(good.target);
  });

  it("refuses the eleventh Linear config of a repo with limit_reached", async () => {
    for (let i = 0; i < MAX_SINKS_PER_REPO; i++) await linear();
    expect(await refusal(linear())).toBe("limit_reached");
  });

  it("refuses an unknown team or assignee and a malformed team key, storing nothing", async () => {
    teams = [];
    expect(await refusal(linear())).toBe("team_not_found");
    teams = [{ id: "team_1", key: "ENG" }];
    users = [];
    expect(await refusal(linear({ assigneeEmail: "nobody@acme.test" }))).toBe("assignee_not_found");
    queries = [];
    expect(await refusal(linear({ teamKey: "eng" }))).toBe("team_not_found");
    expect(queries).toEqual([]);
    expect(await count("sink_configs")).toBe(0);
  });

  it("refuses a rejected key with bad_token and a rate limit with invalid and a retry hint", async () => {
    reply = () => new Response("{}", { status: 401 });
    const badKey = await linear().catch((e: unknown) => e);
    expect(badKey).toMatchObject({ code: "bad_token", message: "Linear did not accept the API key." });
    reply = (query) => (query.includes("users(") ? new Response("{}", { status: 429 }) : Response.json({ data: { teams: { nodes: teams }, team: { states: { nodes: [] } } } }));
    const limited = await linear({ assigneeEmail: "dana@acme.test" }).catch((e: unknown) => e);
    expect(limited).toMatchObject({ code: "invalid", message: "Linear did not answer or is limiting requests. Try again in a minute." });
    expect(String((limited as Error).message)).not.toContain(LIN_KEY);
    expect(await count("sink_configs")).toBe(0);
  });

  it("tests a Linear config with the viewer query only", async () => {
    const { sink } = await linear();
    queries = [];
    expect(await sendTestDelivery(env, ta, actor, sink.id)).toEqual({ kind: "ok" });
    expect(queries).toEqual(["query { viewer { id } }"]);
    reply = () => new Response("{}", { status: 401 });
    expect(await sendTestDelivery(env, ta, actor, sink.id)).toEqual({ kind: "fail", httpStatus: 401, disable: "linear_unauthorized" });
    expect(await count("sink_messages")).toBe(0);
    expect(await count("sink_deliveries")).toBe(0);
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
