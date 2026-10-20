import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex, hmacSha256 } from "../../src/crypto";
import { agentCredentialHash, insertAgent } from "../../src/db/agents";
import { bind } from "../../src/db/bindings";
import { tenantDb } from "../../src/db/tenant";
import worker from "../../src/index";
import { SINK_ADD_CALLBACK_ID } from "../../src/slack/sink-modal";
import { S } from "../../src/strings";
import { testClock } from "../clock";
import { CHANNEL, type CommandWorld, INSTALLATION, LOGIN, REPO, setUpCommandWorld, slackCalls, TEAM, USER, zeroci } from "../commands-helpers";

const TG_API = "https://tg.test";
const BOT_TOKEN = `123456789:AAH${"s".repeat(32)}`;
const CHAT = "-1001234567890";
const HOOK = "https://hooks.example.com/zeroci";
/** Every Slack method this feature may call. */
const SINK_SLACK_METHODS = ["views.open", "chat.postEphemeral", "chat.postMessage"];

let world: CommandWorld;
let logs: string[];
const savedBase = env.TELEGRAM_API_BASE;

beforeEach(async () => {
  world = await setUpCommandWorld();
  world.roles[LOGIN] = "maintain";
  const t = tenantDb(env.DB, INSTALLATION);
  await insertAgent(t, {
    agent_id: "agt_sink",
    name: "builder",
    hostname: "builder.local",
    os: "linux",
    arch: "amd64",
    credential_hash: await agentCredentialHash("cred"),
    agent_version: "0.1.0",
    paired_by_github_id: 7001,
    paired_at: 1,
  });
  await bind(t, REPO.repo_id, "checks", "agt_sink");
  world.slack.respond("POST", "/api/views.open", () => Response.json({ ok: true, view: { id: "V1" } }));
  world.slack.respond("POST", "/api/chat.postEphemeral", () => Response.json({ ok: true, message_ts: "1.2" }));
  env.TELEGRAM_API_BASE = TG_API;
  world.gh.respond("POST", /\/getMe$/, () => Response.json({ ok: true, result: { id: 123456789, is_bot: true, username: "acme_ci_bot" } }));
  world.gh.respond("POST", /\/getChat$/, () => Response.json({ ok: true, result: { id: Number(CHAT), type: "supergroup", title: "Acme CI" } }));
  world.gh.respond("POST", "/zeroci", () => new Response("ok"));
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  world.restore();
  env.TELEGRAM_API_BASE = savedBase;
  vi.restoreAllMocks();
});

/** The string at key of a recorded request body or a parsed JSON object; fails the test when there is none. */
function stringAt(value: unknown, key: string): string {
  const found: unknown = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  if (typeof found !== "string") throw new Error(`no string ${key} in ${JSON.stringify(value)}`);
  return found;
}

/** The Add sink modal the last views.open call opened, as Slack holds it. */
function openedModal(): { callback_id: string; private_metadata: string } {
  const view: unknown = JSON.parse(stringAt(slackCalls(world, "views.open").at(-1)?.body, "view"));
  return { callback_id: stringAt(view, "callback_id"), private_metadata: stringAt(view, "private_metadata") };
}

/** The opened modal with fields filled in, as Slack's view_submission carries it. */
function filled(fields: Record<string, string>) {
  const values = Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [
      field,
      { [field]: field === "kind" ? { type: "radio_buttons", selected_option: { value } } : { type: "plain_text_input", value } },
    ]),
  );
  return { ...openedModal(), state: { values } };
}

/** Submits view as userId through the signed /slack/interactive endpoint and returns Slack's answer. */
async function submit(view: unknown, userId = USER): Promise<{ response_action: string; errors?: Record<string, string>; view?: { blocks: unknown[] } }> {
  const payload = { type: "view_submission", team: { id: TEAM }, user: { id: userId, team_id: TEAM }, trigger_id: "1.3.trig", view };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const ts = Math.floor(testClock.now() / 1000);
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${hex(await hmacSha256(env.SLACK_SIGNING_SECRET, `v0:${ts}:${body}`))}`,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://hub.test/slack/interactive", { method: "POST", headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return res.json();
}

/** Every value of every row in every D1 table, as one string. */
async function wholeDatabase(): Promise<string> {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{
    name: string;
  }>();
  const dumps = await Promise.all(results.map(({ name }) => env.DB.prepare(`SELECT * FROM "${name}"`).all()));
  return JSON.stringify(dumps.map((d) => d.results));
}

async function sinkRows(): Promise<{ id: string; kind: string }[]> {
  return (await env.DB.prepare("SELECT id, kind FROM sink_configs").all<{ id: string; kind: string }>()).results;
}

function expectOnlySinkSlackMethods(): void {
  const methods = world.slack.calls.map((c) => new URL(c.url)).filter((u) => u.host === "slack.com").map((u) => u.pathname.replace("/api/", ""));
  expect(methods.filter((m) => !SINK_SLACK_METHODS.includes(m))).toEqual([]);
}

/** Adds a webhook sink through the command and the modal; returns its id and the ephemeral result text. */
async function addWebhook(): Promise<{ id: string; text: string }> {
  await zeroci(world, "sink add acme/api");
  expect(await submit(filled({ kind: "webhook", webhook_url: HOOK }))).toEqual({ response_action: "clear" });
  const [row] = await sinkRows();
  const text = stringAt(slackCalls(world, "chat.postEphemeral").at(-1)?.body, "text");
  return { id: row!.id, text };
}

describe("/zeroci sink add", () => {
  it("opens the Add sink modal once, for a maintainer, with the repo and channel in its metadata", async () => {
    const reply = await zeroci(world, "sink add acme/api");

    expect(reply.text).toBe(S.slack.sinkFormOpened("acme/api"));
    const opens = slackCalls(world, "views.open");
    expect(opens).toHaveLength(1);
    expect(stringAt(opens[0]?.body, "trigger_id")).toBe("1.2.trig");
    const modal = openedModal();
    expect(modal.callback_id).toBe(SINK_ADD_CALLBACK_ID);
    expect(JSON.parse(modal.private_metadata)).toEqual({ repo: "acme/api", channel: CHANNEL });
  });

  it("opens it for an admin too", async () => {
    world.roles[LOGIN] = "admin";
    await zeroci(world, "sink add acme/api");
    expect(slackCalls(world, "views.open")).toHaveLength(1);
  });

  it("refuses a user with only write, and opens nothing", async () => {
    world.roles[LOGIN] = "write";
    const reply = await zeroci(world, "sink add acme/api");
    expect(reply.text).toBe(S.slack.forbidden);
    expect(slackCalls(world, "views.open")).toEqual([]);
  });

  it("refuses an unlinked user", async () => {
    const reply = await zeroci(world, "sink add acme/api", "U0STRANGER");
    expect(reply.text).toBe(S.slack.notLinked);
    expect(slackCalls(world, "views.open")).toEqual([]);
  });

  it("refuses a repo outside the linked installations", async () => {
    const reply = await zeroci(world, "sink add other/repo");
    expect(reply.text).toBe(S.slack.repoNotFound);
    expect(slackCalls(world, "views.open")).toEqual([]);
  });
});

describe("secrets in command text", () => {
  it.each([
    ["a bot token after add", `sink add acme/api ${BOT_TOKEN}`],
    ["a bot token in place of the repo", `sink add ${BOT_TOKEN}`],
    ["a webhook URL", `sink add acme/api ${HOOK}?token=q`],
    ["a bot token after list", `sink list ${BOT_TOKEN}`],
  ])("refuses %s and keeps it out of D1 and the logs", async (_, text) => {
    const secret = text.split(" ").at(-1)!;
    const reply = await zeroci(world, text);

    expect(reply.text).toBe(S.slack.sinkSecretInCommand);
    expect(slackCalls(world, "views.open")).toEqual([]);
    expect(await sinkRows()).toEqual([]);
    expect(await wholeDatabase()).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
    expectOnlySinkSlackMethods();
  });
});

describe("Add sink submission", () => {
  it("adds a webhook sink and shows its secret once, ephemeral to the submitter, never in a channel post", async () => {
    const { id, text } = await addWebhook();

    const ephemerals = slackCalls(world, "chat.postEphemeral");
    expect(ephemerals).toHaveLength(1);
    expect(ephemerals[0]?.body).toMatchObject({ channel: CHANNEL, user: USER });
    expect(text).toContain(id);
    expect(text).toMatch(/zcwh_/);
    expect(text).toContain(S.slack.sinkSecretOnce);
    const secret = /zcwh_[A-Za-z0-9_-]+/.exec(text)![0];
    expect(slackCalls(world, "chat.postMessage").filter((c) => JSON.stringify(c.body).includes("zcwh_"))).toEqual([]);
    expect(await wholeDatabase()).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
    expectOnlySinkSlackMethods();
  });

  it("adds a Telegram sink after the service checked the token and chat, and never echoes the token", async () => {
    await zeroci(world, "sink add acme/api");
    expect(await submit(filled({ kind: "telegram", bot_token: BOT_TOKEN, chat_id: CHAT, label: "CI" }))).toEqual({ response_action: "clear" });

    expect(await sinkRows()).toEqual([{ id: expect.any(String), kind: "telegram" }]);
    expect(world.gh.calls.map((c) => new URL(c.url).pathname)).toEqual(expect.arrayContaining([`/bot${BOT_TOKEN}/getMe`, `/bot${BOT_TOKEN}/getChat`]));
    const text = stringAt(slackCalls(world, "chat.postEphemeral")[0]?.body, "text");
    expect(text).toContain(`chat ${CHAT}`);
    expect(text).not.toContain(BOT_TOKEN);
    expect(await wholeDatabase()).not.toContain(BOT_TOKEN);
    expect(logs.join("\n")).not.toContain(BOT_TOKEN);
  });

  it("checks the submitter's role again: a maintainer demoted to write before submitting adds nothing", async () => {
    await zeroci(world, "sink add acme/api");
    world.roles[LOGIN] = "write";

    const answer = await submit(filled({ kind: "webhook", webhook_url: HOOK }));

    expect(answer).toEqual({ response_action: "errors", errors: { kind: S.slack.forbidden } });
    expect(await sinkRows()).toEqual([]);
    expect(slackCalls(world, "chat.postEphemeral")).toEqual([]);
  });

  it("shows the service's refusal on the field it concerns", async () => {
    await zeroci(world, "sink add acme/api");
    const answer = await submit(filled({ kind: "webhook", webhook_url: "http://hooks.example.com/zeroci" }));
    expect(answer).toEqual({ response_action: "errors", errors: { webhook_url: S.sinks.errors.not_https } });
    expect(await sinkRows()).toEqual([]);
  });

  it("names missing fields without calling the service", async () => {
    await zeroci(world, "sink add acme/api");
    const answer = await submit(filled({ kind: "telegram", chat_id: CHAT }));
    expect(answer).toEqual({ response_action: "errors", errors: { bot_token: S.slack.sinkModal.needBotToken } });
    expect(world.gh.calls.filter((c) => c.url.startsWith(TG_API))).toEqual([]);
  });

  it("shows the result in the modal when Slack refuses the ephemeral post, so the secret is not lost", async () => {
    world.slack.respond("POST", "/api/chat.postEphemeral", () => Response.json({ ok: false, error: "channel_not_found" }));
    await zeroci(world, "sink add acme/api");

    const answer = await submit(filled({ kind: "webhook", webhook_url: HOOK }));

    expect(answer.response_action).toBe("update");
    expect(JSON.stringify(answer.view)).toMatch(/zcwh_/);
    expect(await sinkRows()).toHaveLength(1);
  });
});

describe("/zeroci sink list, test and remove", () => {
  it("lists the repo's sinks with their target redacted and no secret", async () => {
    const { id, text } = await addWebhook();
    const secret = /zcwh_[A-Za-z0-9_-]+/.exec(text)![0];

    const reply = await zeroci(world, "sink list acme/api");

    expect(reply.text).toContain(S.slack.sinkListHeader("acme/api"));
    expect(reply.text).toContain(`${id}: Webhook, https://hooks.example.com/zeroci, enabled`);
    expect(reply.text).not.toContain(secret);
  });

  it("says when the repo has no sinks", async () => {
    expect((await zeroci(world, "sink list acme/api")).text).toBe(S.slack.sinkNone("acme/api"));
  });

  it("sends a test delivery through the service", async () => {
    const { id } = await addWebhook();
    const before = world.gh.calls.length;

    const reply = await zeroci(world, `sink test ${id}`);

    expect(reply.text).toBe(S.slack.sinkTestOk(id));
    const posts = world.gh.calls.slice(before).filter((c) => c.url === HOOK);
    expect(posts).toHaveLength(1);
  });

  it("removes the sink through the service", async () => {
    const { id } = await addWebhook();

    const reply = await zeroci(world, `sink remove ${id}`);

    expect(reply.text).toBe(S.slack.sinkRemoved(id, "acme/api"));
    expect(await sinkRows()).toEqual([]);
  });

  it("refuses list, test and remove to a user with only write", async () => {
    const { id } = await addWebhook();
    world.roles[LOGIN] = "write";
    const before = world.gh.calls.filter((c) => c.url === HOOK).length;

    for (const text of ["sink list acme/api", `sink test ${id}`, `sink remove ${id}`]) {
      expect((await zeroci(world, text)).text).toBe(S.slack.forbidden);
    }
    expect(await sinkRows()).toHaveLength(1);
    expect(world.gh.calls.filter((c) => c.url === HOOK)).toHaveLength(before);
  });

  it("does not find a sink of an installation the workspace is not linked to", async () => {
    expect((await zeroci(world, "sink remove snk_missing")).text).toBe(S.slack.sinkNotFound("snk_missing"));
  });

  it("answers usage for a missing or unknown subcommand", async () => {
    for (const text of ["sink", "sink add", "sink purge acme/api", "sink add acme/api extra"]) {
      expect((await zeroci(world, text)).text).toBe(S.slack.usage(S.slack.sinkUsage));
    }
  });
});
