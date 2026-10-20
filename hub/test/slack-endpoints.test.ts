import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex, hmacSha256 } from "../src/crypto";
import { runCron } from "../src/cron";
import { upsertWorkspace } from "../src/db/workspaces";
import type { Env } from "../src/env";
import worker from "../src/index";
import { QUOTAS } from "../src/quotas";
import { type SlackActionCtx, type SlackCommandCtx, registerAction, registerCommand, registerEvent, resetRegistryForTests } from "../src/slack/registry";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import type { FakeService } from "./fakes/http";
import { createFakeSlack } from "./fakes/slack";

const TEAM = "T0ACME";
const RESPONSE_URL = "https://hooks.slack.com/commands/T0ACME/1/abc";
const FORM = "application/x-www-form-urlencoded";

let slack: FakeService;
let responseStatus: () => number;
let doCalls: string[];
const restore: (() => void)[] = [];

/** The real SlackWorkspaceDO namespace, recording the URL of every request the Worker sends it. */
function recordingSlackDOs(): Env["SLACK_DO"] {
  const real = env.SLACK_DO;
  const namespace: Pick<DurableObjectNamespace, "idFromName" | "get"> = {
    idFromName: (name) => real.idFromName(name),
    get: (id) =>
      ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          doCalls.push(new Request(input, init).url);
          return real.get(id).fetch(input, init);
        },
      }) as unknown as DurableObjectStub,
  };
  return namespace as unknown as Env["SLACK_DO"];
}

type SendOptions = { contentType?: string; signed?: boolean; env?: Partial<Env> };

/** Sends a Slack request to the Worker; settle() waits for the work it left in waitUntil. */
async function send(path: string, body: string, opts: SendOptions = {}): Promise<{ res: Response; settle: () => Promise<void> }> {
  const headers = new Headers({ "content-type": opts.contentType ?? FORM });
  if (opts.signed !== false) {
    const ts = Math.floor(testClock.now() / 1000);
    headers.set("x-slack-request-timestamp", String(ts));
    headers.set("x-slack-signature", `v0=${hex(await hmacSha256(env.SLACK_SIGNING_SECRET, `v0:${ts}:${body}`))}`);
  }
  const testEnv: Env = { ...env, SLACK_DO: recordingSlackDOs(), ...opts.env };
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://hub.test${path}`, { method: "POST", headers, body }), testEnv, ctx);
  return { res, settle: () => waitOnExecutionContext(ctx) };
}

async function post(path: string, body: string, opts: SendOptions = {}): Promise<Response> {
  const { res, settle } = await send(path, body, opts);
  await settle();
  return res;
}

function commandBody(text: string, overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    token: "legacy",
    team_id: TEAM,
    user_id: "U0USER",
    channel_id: "C0CHAN",
    command: "/zeroci",
    text,
    response_url: RESPONSE_URL,
    trigger_id: "1.2.trig",
    ...overrides,
  }).toString();
}

function eventBody(eventId: string, event: Record<string, unknown> = { type: "app_home_opened", user: "U0USER" }): string {
  return JSON.stringify({ type: "event_callback", team_id: TEAM, event_id: eventId, event });
}

function interactiveBody(payload: Record<string, unknown>): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function blockActions(actionId: string, value: string): Record<string, unknown> {
  return {
    type: "block_actions",
    team: { id: TEAM },
    user: { id: "U0USER", team_id: TEAM },
    trigger_id: "1.2.trig",
    response_url: "https://hooks.slack.com/actions/T0ACME/1/xyz",
    channel: { id: "C0CHAN" },
    message: { ts: "1700000000.000100" },
    actions: [{ action_id: actionId, value, type: "button" }],
  };
}

function responseUrlPosts(): { url: string; body: unknown }[] {
  return slack.calls.filter((c) => c.method === "POST" && new URL(c.url).host === "hooks.slack.com").map(({ url, body }) => ({ url, body }));
}

function loggedEvents(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
}

beforeEach(async () => {
  await clearTables();
  resetRegistryForTests();
  await upsertWorkspace(env.DB, {
    team_id: TEAM,
    team_name: "Acme",
    bot_user_id: "U0BOT",
    bot_token_ct: new Uint8Array([1]),
    key_version: 1,
    installed_by: "U0ADMIN",
    status: "active",
    created_at: 1,
  });
  doCalls = [];
  responseStatus = () => 200;
  slack = createFakeSlack();
  slack.respond("POST", /^\/(commands|actions)\//, () => new Response("ok", { status: responseStatus() }));
  const saved = env.__TEST_FETCHER;
  env.__TEST_FETCHER = slack.fetcher;
  restore.push(() => {
    env.__TEST_FETCHER = saved;
  });
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  vi.restoreAllMocks();
  resetRegistryForTests();
});

describe("/slack/events", () => {
  it("echoes the url_verification challenge", async () => {
    const res = await post("/slack/events", JSON.stringify({ type: "url_verification", token: "x", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" }), {
      contentType: "application/json",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
  });

  it("answers ssl_check=1 with an empty 200", async () => {
    const res = await post("/slack/events", "ssl_check=1&token=x");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("dispatches an event delivered twice exactly once", async () => {
    const seen: Record<string, unknown>[] = [];
    registerEvent("app_home_opened", async (_env, teamId, event) => {
      seen.push({ teamId, ...event });
    });

    for (let i = 0; i < 2; i++) {
      const res = await post("/slack/events", eventBody("Ev0001"), { contentType: "application/json" });
      expect(res.status).toBe(200);
    }

    expect(seen).toEqual([{ teamId: TEAM, type: "app_home_opened", user: "U0USER" }]);
  });

  it("lets an event id through again once cron purged its expired dedupe row", async () => {
    let calls = 0;
    registerEvent("app_home_opened", async () => {
      calls++;
    });
    await post("/slack/events", eventBody("EvOld"), { contentType: "application/json" });
    testClock.advance(12 * 60 * 60 * 1000);
    await post("/slack/events", eventBody("EvNew"), { contentType: "application/json" });
    testClock.advance(12 * 60 * 60 * 1000 + 1);

    await runCron(env, "*/5 * * * *");

    const { results } = await env.DB.prepare("SELECT event_id FROM slack_events ORDER BY event_id").all<{ event_id: string }>();
    expect(results.map((r) => r.event_id)).toEqual(["EvNew"]);
    await post("/slack/events", eventBody("EvOld"), { contentType: "application/json" });
    await post("/slack/events", eventBody("EvNew"), { contentType: "application/json" });
    expect(calls).toBe(3);
  });

  it("acks an event from an unknown workspace without dispatching it", async () => {
    const log = vi.spyOn(console, "log");
    let calls = 0;
    registerEvent("app_home_opened", async () => {
      calls++;
    });

    const res = await post("/slack/events", JSON.stringify({ type: "event_callback", team_id: "T0STRANGER", event_id: "Ev1", event: { type: "app_home_opened" } }), {
      contentType: "application/json",
    });

    expect(res.status).toBe(200);
    expect(calls).toBe(0);
    expect(loggedEvents(log)).toContainEqual(expect.objectContaining({ event: "slack_unknown_team", team_id: "T0STRANGER" }));
  });
});

describe("/slack/commands", () => {
  it("acks a slow command at once and posts the handler's reply to response_url", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ctxSeen: Omit<SlackCommandCtx, "env"> | undefined;
    registerCommand("status", async ({ env: _env, ...ctx }) => {
      ctxSeen = ctx;
      await gate;
      testClock.advance(5000);
      return { response_type: "ephemeral", text: "all green", blocks: [{ type: "divider" }] };
    });

    const { res, settle } = await send("/slack/commands", commandBody("status acme/app"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ response_type: "ephemeral", text: S.slack.working });
    expect(responseUrlPosts()).toEqual([]);
    release();
    await settle();
    expect(ctxSeen).toEqual({
      teamId: TEAM,
      userId: "U0USER",
      channelId: "C0CHAN",
      text: "status acme/app",
      responseUrl: RESPONSE_URL,
      triggerId: "1.2.trig",
    });
    expect(responseUrlPosts()).toEqual([
      { url: RESPONSE_URL, body: { response_type: "ephemeral", text: "all green", blocks: [{ type: "divider" }] } },
    ]);
  });

  it("retries the response_url POST once when Slack answers 5xx", async () => {
    registerCommand("status", async () => ({ text: "done" }));
    const statuses = [503, 200];
    responseStatus = () => statuses.shift() ?? 200;

    await post("/slack/commands", commandBody("status"));

    expect(responseUrlPosts()).toEqual([
      { url: RESPONSE_URL, body: { text: "done" } },
      { url: RESPONSE_URL, body: { text: "done" } },
    ]);
  });

  it("posts a generic failure to response_url when the handler throws", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    registerCommand("status", async () => {
      throw new Error("boom");
    });

    await post("/slack/commands", commandBody("status"));

    expect(responseUrlPosts()).toEqual([{ url: RESPONSE_URL, body: { response_type: "ephemeral", text: S.slack.failed } }]);
    expect(loggedEvents(errors)).toContainEqual(expect.objectContaining({ team_id: TEAM, command: "status" }));
  });

  it("answers the 61st command in a minute with slow-down and keeps it from the DO", async () => {
    testClock.advance(60_000 - (testClock.now() % 60_000));
    registerCommand("status", async () => ({ text: "ok" }));

    for (let i = 0; i < QUOTAS.slackCmdsPerMin; i++) {
      const res = await post("/slack/commands", commandBody("status"));
      expect(await res.json()).toEqual({ response_type: "ephemeral", text: S.slack.working });
    }
    expect(doCalls).toHaveLength(QUOTAS.slackCmdsPerMin);

    const res = await post("/slack/commands", commandBody("status"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ response_type: "ephemeral", text: S.slack.slowDown });
    expect(doCalls).toHaveLength(QUOTAS.slackCmdsPerMin);
  });

  it("answers with the updating notice while a rotation is in progress", async () => {
    registerCommand("status", async () => ({ text: "ok" }));

    const res = await post("/slack/commands", commandBody("status"), { env: { ROTATION_IN_PROGRESS: "1" } });

    expect(await res.json()).toEqual({ response_type: "ephemeral", text: S.slack.updating });
    expect(doCalls).toEqual([]);
  });

  it("answers an unknown subcommand with help synchronously", async () => {
    registerCommand("status", async () => ({ text: "ok" }));

    const res = await post("/slack/commands", commandBody("frobnicate now"));

    expect(await res.json()).toEqual({ response_type: "ephemeral", text: S.slack.help });
    expect(doCalls).toEqual([]);
    expect(responseUrlPosts()).toEqual([]);
  });

  it("answers an unknown subcommand with the registered help command's reply", async () => {
    registerCommand("", async () => ({ response_type: "ephemeral", text: "Try /zeroci status" }));

    const res = await post("/slack/commands", commandBody("frobnicate"));

    expect(await res.json()).toEqual({ response_type: "ephemeral", text: "Try /zeroci status" });
    expect(doCalls).toEqual([]);
  });
});

describe("/slack/interactive", () => {
  it("routes action id run.retry:123 to the handler registered for run.retry", async () => {
    const seen: Omit<SlackActionCtx, "env">[] = [];
    registerAction("run", async () => {
      throw new Error("the shorter prefix must not win");
    });
    registerAction("run.retry", async ({ env: _env, ...ctx }) => {
      seen.push(ctx);
      return { text: "Retrying run 123", replace_original: true };
    });

    const res = await post("/slack/interactive", interactiveBody(blockActions("run.retry:123", "123")));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(seen).toEqual([
      {
        teamId: TEAM,
        userId: "U0USER",
        actionId: "run.retry:123",
        value: "123",
        responseUrl: "https://hooks.slack.com/actions/T0ACME/1/xyz",
        triggerId: "1.2.trig",
        channelId: "C0CHAN",
        messageTs: "1700000000.000100",
      },
    ]);
    expect(responseUrlPosts()).toEqual([
      { url: "https://hooks.slack.com/actions/T0ACME/1/xyz", body: { text: "Retrying run 123", replace_original: true } },
    ]);
  });

  it("does not match an action id that only shares the prefix's leading characters", async () => {
    let calls = 0;
    registerAction("run.retry", async () => {
      calls++;
      return null;
    });

    await post("/slack/interactive", interactiveBody(blockActions("run.retryall", "x")));

    expect(calls).toBe(0);
    expect(doCalls).toEqual([]);
  });

  it("answers a view_submission with response_action clear after dispatching it", async () => {
    const seen: Omit<SlackActionCtx, "env">[] = [];
    registerAction("fork:approve", async ({ env: _env, ...ctx }) => {
      seen.push(ctx);
      return null;
    });
    const view = { id: "V1", callback_id: "fork:approve", private_metadata: "run-9", state: { values: {} } };

    const res = await post("/slack/interactive", interactiveBody({ type: "view_submission", team: { id: TEAM }, user: { id: "U0USER" }, trigger_id: "t", view }));

    expect(await res.json()).toEqual({ response_action: "clear" });
    expect(seen).toEqual([{ teamId: TEAM, userId: "U0USER", actionId: "fork:approve", value: "run-9", responseUrl: null, triggerId: "t", view }]);
    expect(responseUrlPosts()).toEqual([]);
  });
});

describe("unsigned requests", () => {
  it.each([
    ["/slack/events", eventBody("EvUnsigned"), "application/json"],
    ["/slack/commands", commandBody("status"), FORM],
    ["/slack/interactive", interactiveBody(blockActions("run.retry:1", "1")), FORM],
  ])("%s answers 401 and dispatches nothing", async (path, body, contentType) => {
    let calls = 0;
    registerEvent("app_home_opened", async () => {
      calls++;
    });
    registerCommand("status", async () => {
      calls++;
      return { text: "ok" };
    });
    registerAction("run.retry", async () => {
      calls++;
      return null;
    });

    const res = await post(path, body, { contentType, signed: false });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "slack_bad_signature" });
    expect(calls).toBe(0);
    expect(doCalls).toEqual([]);
    const { results } = await env.DB.prepare("SELECT event_id FROM slack_events").all();
    expect(results).toEqual([]);
  });
});
