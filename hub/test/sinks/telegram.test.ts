import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSinkConfig, getSinkConfigWithSecret, getSinkMessage, type SinkConfigWithSecret } from "../../src/db/sinks";
import { tenantDb } from "../../src/db/tenant";
import type { Clock } from "../../src/do/clock";
import { delivererFor, type OutboxDelivery } from "../../src/sinks/deliverers";
import { renderTelegram, telegramDeliverer, validateTelegramConfig } from "../../src/sinks/telegram";
import type { RunState, RunView } from "../../src/sinks/types";
import type { FakeService } from "../fakes/http";
import { botError, botMethod, createFakeTelegram, FAKE_TELEGRAM_API } from "../fakes/telegram";

const INSTALLATION = 61;
const TOKEN = "123456:SECRET-TOKEN";
const CHAT = "-100123";
const t = tenantDb(env.DB, INSTALLATION);

let tg: FakeService;
let cfg: SinkConfigWithSecret;
let saved: { fetcher: typeof env.__TEST_FETCHER; base: string; clock: typeof env.__TEST_CLOCK };
let attempt = 0;

beforeEach(async () => {
  tg = createFakeTelegram();
  saved = { fetcher: env.__TEST_FETCHER, base: env.TELEGRAM_API_BASE, clock: env.__TEST_CLOCK };
  env.__TEST_FETCHER = tg.fetcher;
  env.TELEGRAM_API_BASE = FAKE_TELEGRAM_API;
  // A fresh sink per test, so each has its own messages and outbox.
  const row = await createSinkConfig(env, t, { kind: "telegram", repo: "org/api", target: CHAT, secret: TOKEN, createdBy: "slack:T1:U1" });
  const found = await getSinkConfigWithSecret(env, t, row.id);
  if (!found) throw new Error("sink config missing");
  cfg = found;
});

afterEach(() => {
  env.__TEST_FETCHER = saved.fetcher;
  env.TELEGRAM_API_BASE = saved.base;
  env.__TEST_CLOCK = saved.clock;
  vi.restoreAllMocks();
});

function view(state: RunState, jobs: RunView["jobs"] = []): RunView {
  return {
    installationId: INSTALLATION,
    repoId: 1,
    repo: "org/api",
    triggerId: "trg_1",
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    ref: "refs/heads/main",
    event: "push",
    target: "checks",
    state,
    commitTitle: "Fix the build",
    authorLogin: "dev",
    jobs,
  };
}

function deliver(run: RunView) {
  attempt += 1;
  const item: OutboxDelivery = {
    installationId: INSTALLATION,
    sinkId: cfg.id,
    runId: run.triggerId,
    terminal: false,
    payload: run,
    enqueuedAt: 0,
    deliveryId: `d${attempt}`,
  };
  return telegramDeliverer.deliver(env, cfg, item, 1);
}

function sendsMessage(id = 77): void {
  tg.respond("POST", botMethod("sendMessage"), () => Response.json({ ok: true, result: { message_id: id, chat: { id: Number(CHAT) } } }));
}

function editsMessage(): void {
  tg.respond("POST", botMethod("editMessageText"), () => Response.json({ ok: true, result: { message_id: 77 } }));
}

const message = () => getSinkMessage(t, cfg.id, "trg_1");

describe("telegramDeliverer", () => {
  it("is the registered deliverer of telegram sinks", () => {
    expect(delivererFor("telegram")).toBe(telegramDeliverer);
  });

  it("sends the first update, keeps its message_id and edits that message on the next", async () => {
    sendsMessage();
    editsMessage();

    expect(await deliver(view("running"))).toEqual({ kind: "ok", externalId: "77" });
    expect(tg.calls).toEqual([
      {
        method: "POST",
        url: `${FAKE_TELEGRAM_API}/bot${TOKEN}/sendMessage`,
        body: { chat_id: CHAT, text: renderTelegram(view("running")).text, parse_mode: "HTML", disable_web_page_preview: true },
      },
    ]);
    expect((await message())?.externalId).toBe("77");

    expect(await deliver(view("success"))).toEqual({ kind: "ok", externalId: "77" });
    expect(tg.calls[1]).toEqual({
      method: "POST",
      url: `${FAKE_TELEGRAM_API}/bot${TOKEN}/editMessageText`,
      body: { chat_id: CHAT, message_id: 77, text: renderTelegram(view("success")).text, parse_mode: "HTML", disable_web_page_preview: true },
    });
  });

  it("makes no call for a render equal to the last one sent", async () => {
    sendsMessage();
    await deliver(view("running"));

    expect(await deliver(view("running"))).toEqual({ kind: "ok", externalId: "77" });
    expect(tg.calls).toHaveLength(1);
  });

  it("retries after retry_after on 429", async () => {
    tg.respond("POST", botMethod("sendMessage"), () => botError(429, "Too Many Requests: retry after 7", { retry_after: 7 }));
    expect(await deliver(view("running"))).toEqual({ kind: "retry", afterMs: 7000, httpStatus: 429 });
  });

  it("counts 'message is not modified' as delivered", async () => {
    sendsMessage();
    await deliver(view("running"));
    tg.respond("POST", botMethod("editMessageText"), () =>
      botError(400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same"),
    );

    expect(await deliver(view("success"))).toEqual({ kind: "ok", externalId: "77" });
    expect(await deliver(view("success"))).toEqual({ kind: "ok", externalId: "77" });
    expect(tg.calls).toHaveLength(2);
  });

  it("sends a new message right away when the old one was deleted", async () => {
    sendsMessage();
    await deliver(view("running"));
    tg.respond("POST", botMethod("editMessageText"), () => botError(400, "Bad Request: message to edit not found"));

    expect(await deliver(view("success"))).toEqual({ kind: "retry", afterMs: 0, httpStatus: 400 });
    expect(await message()).toEqual({ externalId: null, lastHash: null });

    sendsMessage(78);
    expect(await deliver(view("success"))).toEqual({ kind: "ok", externalId: "78" });
    expect(new URL(tg.calls.at(-1)?.url ?? "").pathname).toBe(`/bot${TOKEN}/sendMessage`);
    expect((await message())?.externalId).toBe("78");
  });

  it.each([401, 403])("fails and disables the sink on %i", async (status) => {
    tg.respond("POST", botMethod("sendMessage"), () => botError(status, status === 401 ? "Unauthorized" : "Forbidden: bot was kicked from the group chat"));
    expect(await deliver(view("running"))).toEqual({ kind: "fail", httpStatus: status, disable: "telegram_unauthorized" });
  });

  it("fails without disabling on another 4xx", async () => {
    tg.respond("POST", botMethod("sendMessage"), () => botError(400, "Bad Request: chat not found"));
    expect(await deliver(view("running"))).toEqual({ kind: "fail", httpStatus: 400 });
  });

  it("retries on 502 and on a network error", async () => {
    tg.respond("POST", botMethod("sendMessage"), () => new Response("Bad Gateway", { status: 502 }));
    expect(await deliver(view("running"))).toEqual({ kind: "retry", httpStatus: 502 });

    env.__TEST_FETCHER = async (input) => {
      throw new TypeError(`fetch failed: ${String(input)}`);
    };
    expect(await deliver(view("running"))).toEqual({ kind: "retry" });
    expect(await message()).toBeNull();
  });

  it("never prints the bot token, through the outbox either", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => logged.push(args));
    }
    // An hour ahead of the wall clock, so the outbox's alarm runs only when the test runs it.
    let now = Date.now() + 3_600_000;
    const clock: Clock = { now: () => now };
    env.__TEST_CLOCK = clock;

    const throwing = async (input: RequestInfo) => {
      throw new TypeError(`fetch failed: ${String(input instanceof Request ? input.url : input)}`);
    };
    env.__TEST_FETCHER = throwing;
    await deliver(view("running"));
    tg.respond("POST", botMethod("sendMessage"), () => new Response("Bad Gateway", { status: 502 }));
    env.__TEST_FETCHER = tg.fetcher;
    await deliver(view("running"));

    const stub = env.SINK_OUTBOX.get(env.SINK_OUTBOX.idFromName(`${INSTALLATION}:${cfg.id}`));
    env.__TEST_FETCHER = throwing;
    await stub.enqueue({ installationId: INSTALLATION, sinkId: cfg.id, runId: "trg_1", terminal: false, payload: view("running"), enqueuedAt: now });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    now += 3_600_000;
    tg.respond("POST", botMethod("sendMessage"), () => botError(401, "Unauthorized"));
    env.__TEST_FETCHER = tg.fetcher;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await getSinkConfigWithSecret(env, t, cfg.id))?.disabledReason).toBe("telegram_unauthorized");

    expect(logged.length).toBeGreaterThan(0);
    const output = JSON.stringify(logged);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain("SECRET-TOKEN");
  });
});

describe("validateTelegramConfig", () => {
  const validate = () => validateTelegramConfig(tg.fetcher, FAKE_TELEGRAM_API, TOKEN, CHAT);

  it("names the bot and the chat", async () => {
    tg.respond("POST", botMethod("getMe"), () => Response.json({ ok: true, result: { id: 123456, is_bot: true, username: "acme_ci_bot" } }));
    tg.respond("POST", botMethod("getChat"), () => Response.json({ ok: true, result: { id: Number(CHAT), type: "supergroup", title: "Acme CI" } }));
    expect(await validate()).toEqual({ ok: true, botUsername: "acme_ci_bot", chatTitle: "Acme CI" });
    expect(tg.calls.map((c) => [new URL(c.url).pathname, c.body])).toEqual([
      [`/bot${TOKEN}/getMe`, {}],
      [`/bot${TOKEN}/getChat`, { chat_id: CHAT }],
    ]);
  });

  it("returns bad_token when getMe answers 401", async () => {
    tg.respond("POST", botMethod("getMe"), () => botError(401, "Unauthorized"));
    expect(await validate()).toEqual({ ok: false, code: "bad_token" });
    expect(tg.calls).toHaveLength(1);
  });

  it("returns chat_unreachable when getChat answers 400", async () => {
    tg.respond("POST", botMethod("getMe"), () => Response.json({ ok: true, result: { id: 123456, is_bot: true, username: "acme_ci_bot" } }));
    tg.respond("POST", botMethod("getChat"), () => botError(400, "Bad Request: chat not found"));
    expect(await validate()).toEqual({ ok: false, code: "chat_unreachable" });
  });

  it("throws telegram_unreachable without the token when Telegram cannot be reached", async () => {
    const err = await validateTelegramConfig(
      async () => {
        throw new TypeError("network down");
      },
      FAKE_TELEGRAM_API,
      TOKEN,
      CHAT,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "telegram_unreachable", status: 502, message: `POST ${FAKE_TELEGRAM_API}/bot***/getMe failed` });
  });
});
