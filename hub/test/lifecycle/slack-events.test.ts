import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hex, hmacSha256 } from "../../src/crypto";
import { upsertInstallation } from "../../src/db/installations";
import { upsertRepos } from "../../src/db/repos";
import { tenantDb } from "../../src/db/tenant";
import { addWatch } from "../../src/db/watches";
import { linkWorkspace } from "../../src/db/workspaces";
import worker from "../../src/index";
import { slackApi, slackApiFireAndForget } from "../../src/slack/api";
import { clearTables } from "../db/helpers";
import { after, queueStats, useQueueWorld } from "../do/slack-queue-world";
import appUninstalled from "../fixtures/slack/app_uninstalled.json";
import channelLeft from "../fixtures/slack/channel_left.json";
import tokensRevoked from "../fixtures/slack/tokens_revoked.json";

const INSTALLATION = 42;

beforeEach(clearTables);
const world = useQueueWorld();

type Row = Record<string, unknown>;

async function deliver(fixture: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({ ...fixture, team_id: world.team });
  const ts = Math.floor(world.clock.now() / 1000);
  const headers = new Headers({
    "content-type": "application/json",
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${hex(await hmacSha256(env.SLACK_SIGNING_SECRET, `v0:${ts}:${body}`))}`,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://hub.test/slack/events", { method: "POST", headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
}

async function rows(sql: string, ...binds: unknown[]): Promise<Row[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<Row>()).results;
}

function update(ts: string): Record<string, unknown> {
  return { channel: "C0BUILDS", ts, text: "build" };
}

/** Links the workspace to an installation and watches two repos from two channels. */
async function seedWatches(): Promise<void> {
  await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", account_id: INSTALLATION * 10, created_at: 1 });
  const t = tenantDb(env.DB, INSTALLATION);
  await upsertRepos(t, [
    { repo_id: 1001, full_name: "acme/widgets", default_branch: "main" },
    { repo_id: 1002, full_name: "acme/gizmos", default_branch: "main" },
  ]);
  await linkWorkspace(t, world.team, "U0ADMIN", 1);
  const watch = { team_id: world.team, notify: "normal", alert: "channel", created_by: "U0ADMIN" } as const;
  await addWatch(t, { ...watch, repo_id: 1001, channel_id: "C0BUILDS" });
  await addWatch(t, { ...watch, repo_id: 1002, channel_id: "C0BUILDS" });
  await addWatch(t, { ...watch, repo_id: 1001, channel_id: "C0OTHER" });
}

/** Holds the queue behind a 429 and leaves three more updates waiting in it. */
async function fillQueue(): Promise<void> {
  world.slack.respond("POST", "/api/chat.update", () => new Response("", { status: 429, headers: { "retry-after": "5" } }));
  await slackApiFireAndForget(env, world.team, "chat.update", update("0.0"));
  await vi.waitFor(async () => expect((await queueStats(world)).rate_limited_total).toBe(1));
  for (const ts of ["1.0", "2.0", "3.0"]) await slackApiFireAndForget(env, world.team, "chat.update", update(ts));
  expect(await queueStats(world)).toMatchObject({ depth: 4 });
}

/** A later update, once the 429 pause is over, finds the workspace inactive and nothing reaches Slack. */
async function expectSilenced(): Promise<void> {
  const sent = world.slack.calls.length;
  world.slack.respond("POST", /^\/api\//, () => Response.json({ ok: true, ts: "9.0" }));
  await slackApiFireAndForget(env, world.team, "chat.update", update("4.0"));
  await after(world, 60_000);
  await expect(slackApi(env, world.team, "chat.update", update("5.0"))).rejects.toMatchObject({ code: "slack_api", message: "workspace_inactive" });
  expect(world.slack.calls).toHaveLength(sent);
  expect(await queueStats(world)).toMatchObject({ depth: 0 });
}

describe("Slack lifecycle events", () => {
  it("app_uninstalled marks the workspace, wipes its token, links, watches and queue, and stops sends", async () => {
    await seedWatches();
    await fillQueue();

    await deliver(appUninstalled);

    expect(await rows("SELECT status, bot_token_ct FROM workspaces WHERE team_id = ?1", world.team)).toEqual([{ status: "uninstalled", bot_token_ct: null }]);
    expect(await queueStats(world)).toMatchObject({ depth: 0 });
    expect(await rows("SELECT * FROM workspace_links")).toEqual([]);
    expect(await rows("SELECT * FROM watches")).toEqual([]);
    await expectSilenced();
  });

  it("tokens_revoked with a bot token marks the workspace revoked, wipes its token and queue, and stops sends", async () => {
    await fillQueue();

    await deliver(tokensRevoked);

    expect(await rows("SELECT status, bot_token_ct FROM workspaces WHERE team_id = ?1", world.team)).toEqual([{ status: "revoked", bot_token_ct: null }]);
    expect(await queueStats(world)).toMatchObject({ depth: 0 });
    await expectSilenced();
  });

  it("tokens_revoked with only user tokens leaves the workspace active", async () => {
    await deliver({ ...tokensRevoked, event_id: "Ev0USERREVOKED", event: { ...tokensRevoked.event, tokens: { oauth: ["U0ALICE"] } } });
    expect(await rows("SELECT status FROM workspaces WHERE team_id = ?1", world.team)).toEqual([{ status: "active" }]);
  });

  it.each(["channel_left", "group_left"])("%s marks the channel's watches broken", async (type) => {
    await seedWatches();

    await deliver({ ...channelLeft, event: { ...channelLeft.event, type } });

    expect(await rows("SELECT repo_id, channel_id, status, broken_reason FROM watches ORDER BY channel_id, repo_id")).toEqual([
      { repo_id: 1001, channel_id: "C0BUILDS", status: "broken", broken_reason: type },
      { repo_id: 1002, channel_id: "C0BUILDS", status: "broken", broken_reason: type },
      { repo_id: 1001, channel_id: "C0OTHER", status: "active", broken_reason: null },
    ]);
  });
});
