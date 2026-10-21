import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { getWorkspace } from "../../src/db/workspaces";
import type { SlackPriority } from "../../src/do/slack-queue";
import { HubError } from "../../src/errors";
import { slackApi, slackApiFireAndForget } from "../../src/slack/api";
import { after, formField, queueStats, queueStub, useQueueWorld } from "./slack-queue-world";

const world = useQueueWorld();

function calls(method: string) {
  return world.slack.calls.filter((c) => c.url === `https://slack.com/api/${method}`);
}

function texts(method: string): unknown[] {
  return calls(method).map((c) => formField(c.body, "text"));
}

function update(ts: string, text: string): Record<string, unknown> {
  return { channel: "C1", ts, text };
}

function retryAfter(seconds: number): Response {
  return new Response("", { status: 429, headers: { "retry-after": String(seconds) } });
}

/** Queues one chat.update with a 429 answer, so later calls stay queued until the pause ends. */
async function pause(seconds: number, priority: SlackPriority = "normal"): Promise<void> {
  world.slack.respond("POST", "/api/chat.update", () => retryAfter(seconds));
  await slackApiFireAndForget(env, world.team, "chat.update", update("0.0", "hold"), { priority });
  await vi.waitFor(async () => expect((await queueStats(world)).rate_limited_total).toBe(1));
}

describe("SlackWorkspaceDO queue", () => {
  it("sends a call and answers the waiter with Slack's answer", async () => {
    world.slack.respond("POST", "/api/chat.postMessage", ({ body, headers }) =>
      Response.json({ ok: true, ts: "1.0", echo: body, auth: headers.get("authorization") }),
    );
    const res = await slackApi(env, world.team, "chat.postMessage", { channel: "C1", text: "hi", blocks: [{ type: "divider" }], skipped: undefined });
    expect(res).toMatchObject({ ok: true, ts: "1.0", auth: "Bearer xoxb-queue" });
    expect(res.echo).toEqual({ channel: "C1", text: "hi", blocks: '[{"type":"divider"}]' });
    expect(await queueStats(world)).toMatchObject({ depth: 0, sent_last_minute: 1, paused_until: null });
  });

  it("pauses for Retry-After: 7 after a 429, then retries the call and it succeeds", async () => {
    let limited = false;
    world.slack.respond("POST", "/api/chat.update", () => {
      if (limited) return Response.json({ ok: true, ts: "1.0" });
      limited = true;
      return retryAfter(7);
    });
    const start = world.clock.now();
    const pending = slackApi(env, world.team, "chat.update", update("1.0", "a"));
    await vi.waitFor(async () => expect((await queueStats(world)).paused_until).toBe(start + 7000));
    expect(await queueStats(world)).toMatchObject({ depth: 1, rate_limited_total: 1 });

    // Workspace tokens are left, yet nothing goes out before the 7 s are up.
    await slackApiFireAndForget(env, world.team, "chat.update", update("2.0", "b"));
    await after(world, 3000);
    await after(world, 3999);
    expect(calls("chat.update")).toHaveLength(1);

    await after(world, 1);
    expect(await pending).toMatchObject({ ok: true, ts: "1.0" });
    expect(texts("chat.update")).toEqual(["a", "a", "b"]);
    expect(await queueStats(world)).toMatchObject({ depth: 0, paused_until: null, rate_limited_total: 1 });
  });

  it("drops every queued call and marks the workspace revoked on token_revoked", async () => {
    await pause(5);
    for (const ts of ["2.0", "3.0", "4.0"]) await slackApiFireAndForget(env, world.team, "chat.update", update(ts, "queued"));
    const waiting = slackApi(env, world.team, "chat.postMessage", { channel: "C2", text: "waiting" }).catch((err: unknown) => err);
    await vi.waitFor(async () => expect((await queueStats(world)).depth).toBe(5));

    world.slack.respond("POST", /^\/api\//, () => Response.json({ ok: false, error: "token_revoked" }));
    await after(world, 5000);

    const err = await waiting;
    expect(err).toBeInstanceOf(HubError);
    expect(err).toMatchObject({ code: "slack_api", message: "workspace_inactive" });
    expect(world.slack.calls).toHaveLength(2);
    expect(await queueStats(world)).toMatchObject({ depth: 0 });
    expect((await getWorkspace(env.DB, world.team))?.status).toBe("revoked");
    await expect(slackApi(env, world.team, "chat.update", update("5.0", "late"))).rejects.toMatchObject({ message: "workspace_inactive" });
    expect(world.slack.calls).toHaveLength(2);
  });

  it("returns channel_not_found to the waiter once, without a retry", async () => {
    world.slack.respond("POST", "/api/chat.postMessage", () => Response.json({ ok: false, error: "channel_not_found" }));
    await expect(slackApi(env, world.team, "chat.postMessage", { channel: "C404", text: "x" })).rejects.toMatchObject({
      code: "slack_api",
      message: "channel_not_found",
    });
    await after(world, 60_000);
    expect(calls("chat.postMessage")).toHaveLength(1);
    expect(await queueStats(world)).toMatchObject({ depth: 0, rate_limited_total: 0 });
  });

  it("coalesces queued updates for one message and tells the replaced waiter", async () => {
    await pause(2);
    world.slack.respond("POST", "/api/chat.update", ({ body }) => Response.json({ ok: true, ts: "1.0", text: formField(body, "text") }));
    const enqueue = (id: string, text: string, priority: string) =>
      queueStub(world).fetch("https://do/call", {
        method: "POST",
        body: JSON.stringify({
          teamId: world.team,
          wait: true,
          call: { id, method: "chat.update", body: update("1.0", text), priority, coalesceKey: "C1:1.0", enqueuedAt: world.clock.now(), attempts: 0 },
        }),
      });
    const first = enqueue("01A", "one", "terminal");
    await vi.waitFor(async () => expect((await queueStats(world)).depth).toBe(2));
    const second = enqueue("01B", "two", "normal");
    expect(await (await first).json()).toEqual({ ok: true, coalesced: true });
    expect(await queueStats(world)).toMatchObject({ depth: 2 });

    await after(world, 2000);
    expect(await (await second).json()).toMatchObject({ ok: true, data: { text: "two" } });
    expect(texts("chat.update")).toEqual(["hold", "two", "hold"]);
  });

  it("backs off 1, 2, 4 and 8 s after 5xx answers and drops the call after 5 attempts", async () => {
    world.slack.respond("POST", "/api/chat.update", () => new Response("down", { status: 503 }));
    await slackApiFireAndForget(env, world.team, "chat.update", update("1.0", "x"));
    await vi.waitFor(() => expect(calls("chat.update")).toHaveLength(1));
    const backoff: [wait: number, sent: number][] = [
      [1000, 2],
      [2000, 3],
      [4000, 4],
      [8000, 5],
    ];
    for (const [wait, sent] of backoff) {
      await after(world, wait - 1);
      expect(calls("chat.update")).toHaveLength(sent - 1);
      await after(world, 1);
      expect(calls("chat.update")).toHaveLength(sent);
    }
    expect(await queueStats(world)).toMatchObject({ depth: 0 });
    await after(world, 60_000);
    expect(calls("chat.update")).toHaveLength(5);
  });

  it("sends views.open at once while paused", async () => {
    await pause(30);
    world.slack.respond("POST", "/api/views.open", () => Response.json({ ok: true, view: { id: "V1" } }));
    expect(await slackApi(env, world.team, "views.open", { trigger_id: "t", view: {} })).toMatchObject({ view: { id: "V1" } });
    expect(await queueStats(world)).toMatchObject({ depth: 1 });
  });

  it("rejects a normal call when the queue is full of alerts", { timeout: 30_000 }, async () => {
    await pause(30, "alert");
    await Promise.all(
      Array.from({ length: 499 }, (_, i) => slackApiFireAndForget(env, world.team, "chat.update", update(`${i + 1}.0`, "x"), { priority: "alert" })),
    );
    expect(await queueStats(world)).toMatchObject({ depth: 500, dropped_total: 0 });
    expect(await slackApi(env, world.team, "chat.update", update("x.0", "x")).catch((err: unknown) => err)).toMatchObject({ message: "queue_full" });
    await slackApiFireAndForget(env, world.team, "chat.update", update("y.0", "x"), { priority: "terminal" });
    expect(await queueStats(world)).toMatchObject({ depth: 501, dropped_total: 1 });
  });

  it("caps alerts at 600 and refuses a terminal call past that", { timeout: 60_000 }, async () => {
    await pause(30, "alert");
    await Promise.all(
      Array.from({ length: 599 }, (_, i) => slackApiFireAndForget(env, world.team, "chat.update", update(`${i + 1}.0`, "x"), { priority: "alert" })),
    );
    expect(await queueStats(world)).toMatchObject({ depth: 600, dropped_total: 0 });
    await slackApiFireAndForget(env, world.team, "chat.update", update("y.0", "x"), { priority: "terminal" });
    expect(await queueStats(world)).toMatchObject({ depth: 600, dropped_total: 1 });
  });

  it("answers queue_timeout to a waited call still queued after 10 s and never sends it", async () => {
    await pause(30);
    const pending = slackApi(env, world.team, "chat.postMessage", { channel: "C1", text: "late" }).catch((err: unknown) => err);
    await vi.waitFor(async () => expect((await queueStats(world)).depth).toBe(2));
    await after(world, 9_999);
    expect(await queueStats(world)).toMatchObject({ depth: 2 });
    await after(world, 1);
    expect(await pending).toMatchObject({ code: "slack_api", message: "queue_timeout" });
    expect(await queueStats(world)).toMatchObject({ depth: 1 });
    await after(world, 60_000);
    expect(calls("chat.postMessage")).toHaveLength(0);
  });

  it("answers a waited call with Slack's ts when the send outlasts its 10 s", async () => {
    world.slack.respond("POST", "/api/chat.postMessage", () => {
      world.clock.advance(15_000);
      return Response.json({ ok: true, ts: "9.0" });
    });
    expect(await slackApi(env, world.team, "chat.postMessage", { channel: "C1", text: "slow" })).toMatchObject({ ok: true, ts: "9.0" });
    expect(calls("chat.postMessage")).toHaveLength(1);
  });

  it("does not send again a waited call whose send failed after its 10 s", async () => {
    world.slack.respond("POST", "/api/chat.postMessage", () => {
      world.clock.advance(15_000);
      return new Response("down", { status: 503 });
    });
    await expect(slackApi(env, world.team, "chat.postMessage", { channel: "C1", text: "slow" })).rejects.toMatchObject({ message: "queue_timeout" });
    await after(world, 60_000);
    expect(calls("chat.postMessage")).toHaveLength(1);
    expect(await queueStats(world)).toMatchObject({ depth: 0 });
  });
});
