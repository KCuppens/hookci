import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { slackApi, slackApiFireAndForget } from "../../src/slack/api";
import { after, queueStats, useQueueWorld } from "../do/slack-queue-world";

const world = useQueueWorld();

const PUSHES = 30;
const CHANNELS = 15;
const STEP_MS = 2000;
const TERMINAL = "✅ passed";

/** Advances the clock in 250 ms ticks, running the queue's alarm each tick, until work settles. */
async function pumpUntil<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) await after(world, 250);
  return work;
}

describe("Slack outbound burst", () => {
  it("drains 30 pushes of a post, 6 updates and a terminal update without a 429", { timeout: 60_000 }, async () => {
    // Slack's limits as the queue must respect them: 50 chat.update calls in
    // any 60 s and one chat.postMessage per second per channel. Arrival is
    // stamped on entry, before the body is read, so the fake measures the
    // moment the queue sent the call.
    const updates: { at: number; ts: string | undefined; text: string | undefined }[] = [];
    const lastPostAt = new Map<string | undefined, number>();
    let limited = 0;
    let posts = 0;
    const tooMany = () => {
      limited++;
      return new Response("", { status: 429, headers: { "retry-after": "1" } });
    };
    env.__TEST_FETCHER = async (input, init) => {
      const at = world.clock.now();
      const req = new Request(input, init);
      const form = Object.fromEntries(new URLSearchParams(await req.text()));
      if (req.url.endsWith("/chat.postMessage")) {
        const last = lastPostAt.get(form.channel);
        if (last !== undefined && at - last < 1000) return tooMany();
        lastPostAt.set(form.channel, at);
        return Response.json({ ok: true, channel: form.channel, ts: `${++posts}.000` });
      }
      if (updates.filter((u) => u.at > at - 60_000).length >= 50) return tooMany();
      updates.push({ at, ts: form.ts, text: form.text });
      return Response.json({ ok: true });
    };

    const channels = Array.from({ length: PUSHES }, (_, i) => `C0LOAD${i % CHANNELS}`);
    const posted = await pumpUntil(
      Promise.all(channels.map((channel, i) => slackApi(env, world.team, "chat.postMessage", { channel, text: `run ${i} queued` }))),
    );
    const messages = posted.map((res, i) => ({ channel: channels[i], ts: String(res.ts) }));

    let enqueued = 0;
    for (let step = 1; step <= 7; step++) {
      const terminal = step === 7;
      for (const [i, { channel, ts }] of messages.entries()) {
        await slackApiFireAndForget(
          env,
          world.team,
          "chat.update",
          { channel, ts, text: terminal ? `run ${i} ${TERMINAL}` : `run ${i} step ${step}` },
          { coalesceKey: `${channel}:${ts}`, priority: terminal ? "terminal" : "normal" },
        );
        enqueued++;
      }
      for (let ms = 0; ms < STEP_MS; ms += 250) await after(world, 250);
    }
    while ((await queueStats(world)).depth > 0) await after(world, 250);

    expect(limited).toBe(0);
    expect(enqueued).toBe(PUSHES * 7);
    expect(updates.length).toBeLessThan(enqueued);
    for (const [i, { ts }] of messages.entries()) {
      expect(updates.filter((u) => u.ts === ts).at(-1)?.text).toBe(`run ${i} ${TERMINAL}`);
    }
    expect(await queueStats(world)).toMatchObject({ depth: 0, rate_limited_total: 0, paused_until: null });
  });
});
