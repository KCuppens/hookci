import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSinkConfig, getSinkConfigWithSecret, type SinkConfigRow } from "../../src/db/sinks";
import { tenantDb } from "../../src/db/tenant";
import type { Clock } from "../../src/do/clock";
import { OUTBOX_MIN_INTERVAL_MS, RETRY_DELAYS_MS } from "../../src/do/sink-outbox";
import { type DeliveryResult, type OutboxDelivery, registerDeliverer } from "../../src/sinks/deliverers";
import type { RunState, RunView } from "../../src/sinks/types";
import { TERMINAL } from "../../src/slack/badge";

const INSTALLATION = 41;
const t = tenantDb(env.DB, INSTALLATION);

interface Call {
  at: number;
  attempt: number;
  item: OutboxDelivery;
}

let at = 0;
const clock: Clock & { advance(ms: number): void } = {
  now: () => at,
  advance(ms) {
    at += ms;
  },
};
let calls: Call[];
/** What the fake deliverer answers, one per call; ok once they run out. An Error is thrown. */
let answers: (DeliveryResult | Error)[];
let cfg: SinkConfigRow;
let savedClock: typeof env.__TEST_CLOCK;
let undo: () => void;

beforeEach(async () => {
  // An hour ahead of the wall clock, so the outbox's alarms only run when the test runs them.
  at = Date.now() + 3_600_000;
  savedClock = env.__TEST_CLOCK;
  env.__TEST_CLOCK = clock;
  calls = [];
  answers = [];
  undo = registerDeliverer("webhook", {
    async deliver(_env, _cfg, item, attempt) {
      calls.push({ at: clock.now(), attempt, item });
      const answer = answers.shift() ?? { kind: "ok" };
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  // A fresh sink per test, so each gets its own outbox.
  cfg = await createSinkConfig(env, t, { kind: "webhook", repo: "org/api", target: "https://hooks.example/ci", secret: "whsec", createdBy: "slack:T1:U1" });
});

afterEach(() => {
  undo();
  env.__TEST_CLOCK = savedClock;
});

function outbox(sinkId = cfg.id) {
  return env.SINK_OUTBOX.get(env.SINK_OUTBOX.idFromName(`${INSTALLATION}:${sinkId}`));
}

function view(state: RunState, triggerId = "trg_1", currentJob?: string): RunView {
  return {
    installationId: INSTALLATION,
    repoId: 1,
    repo: "org/api",
    triggerId,
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    event: "push",
    target: "main",
    state,
    commitTitle: "Fix the build",
    authorLogin: "dev",
    jobs: [],
    currentJob,
  };
}

async function enqueue(run: RunView, sinkId = cfg.id): Promise<void> {
  await outbox(sinkId).enqueue({ installationId: INSTALLATION, sinkId, runId: run.triggerId, terminal: TERMINAL.has(run.state), payload: run, enqueuedAt: clock.now() });
}

/** Moves the clock on by ms and runs the alarm the outbox set, if any. */
async function after(ms: number, sinkId = cfg.id): Promise<void> {
  clock.advance(ms);
  await runDurableObjectAlarm(outbox(sinkId));
}

async function pending(sinkId = cfg.id): Promise<{ run_id: string; attempt: number; due_at: number }[]> {
  return runInDurableObject(outbox(sinkId), (_, state) =>
    state.storage.sql.exec<{ run_id: string; attempt: number; due_at: number }>("SELECT run_id, attempt, due_at FROM pending ORDER BY due_at").toArray(),
  );
}

async function alarmAt(sinkId = cfg.id): Promise<number | null> {
  return runInDurableObject(outbox(sinkId), (_, state) => state.storage.getAlarm());
}

async function deliveries(sinkId = cfg.id) {
  const { results } = await env.DB.prepare(
    "SELECT delivery_id, run_id, attempt, status, http_status, at FROM sink_deliveries WHERE installation_id = ?1 AND sink_id = ?2 ORDER BY at, attempt",
  )
    .bind(INSTALLATION, sinkId)
    .all<{ delivery_id: string; run_id: string; attempt: number; status: string; http_status: number | null; at: number }>();
  return results;
}

describe("SinkOutboxDO", () => {
  it("delivers only the latest of several updates to a run, once", async () => {
    const t0 = clock.now();
    await enqueue(view("running", "trg_1", "build"));
    await enqueue(view("running", "trg_1", "test"));
    await enqueue(view("running", "trg_1", "lint"));
    expect(await alarmAt()).toBe(t0);

    await after(0);
    await after(60_000);

    expect(calls.map((c) => [c.item.payload.currentJob, c.attempt, c.item.runId, c.item.sinkId])).toEqual([["lint", 1, "trg_1", cfg.id]]);
    expect(await pending()).toEqual([]);
    expect(await alarmAt()).toBeNull();
    expect(await deliveries()).toEqual([{ delivery_id: calls[0]?.item.deliveryId, run_id: "trg_1", attempt: 1, status: "ok", http_status: null, at: t0 }]);
  });

  it("keeps a waiting terminal update over a later non-terminal one", async () => {
    await enqueue(view("success"));
    await enqueue(view("running"));
    await after(0);

    expect(calls.map((c) => c.item.payload.state)).toEqual(["success"]);
    expect(calls[0]?.item.terminal).toBe(true);
  });

  it("retries on the backoff steps with one delivery id, then gives up as failed", async () => {
    answers = Array.from({ length: RETRY_DELAYS_MS.length + 1 }, () => ({ kind: "retry", httpStatus: 503 }) as const);
    const t0 = clock.now();
    await enqueue(view("running"));
    await after(0);

    // An alarm run early sends nothing and waits on.
    await after(RETRY_DELAYS_MS[0] - 1);
    expect(calls).toHaveLength(1);
    expect(await alarmAt()).toBe(t0 + RETRY_DELAYS_MS[0]);
    await after(1);

    for (const delay of RETRY_DELAYS_MS.slice(1)) {
      expect(await pending()).toEqual([{ run_id: "trg_1", attempt: calls.length, due_at: clock.now() + delay }]);
      await after(delay);
    }

    let expected = t0;
    expect(calls.map((c) => c.at)).toEqual([t0, ...RETRY_DELAYS_MS.map((d) => (expected += d))]);
    expect(calls.map((c) => c.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(calls.map((c) => c.item.deliveryId)).size).toBe(1);
    expect(await pending()).toEqual([]);
    expect(await alarmAt()).toBeNull();
    const recorded = await deliveries();
    expect(recorded.map((d) => [d.attempt, d.status, d.http_status])).toEqual([
      [1, "retrying", 503],
      [2, "retrying", 503],
      [3, "retrying", 503],
      [4, "retrying", 503],
      [5, "retrying", 503],
      [6, "failed", 503],
    ]);
    expect(new Set(recorded.map((d) => d.delivery_id))).toEqual(new Set([calls[0]?.item.deliveryId]));
  });

  it("waits the provider's afterMs instead of the backoff step", async () => {
    answers = [{ kind: "retry", afterMs: 5_000 }];
    const t0 = clock.now();
    await enqueue(view("running"));
    await after(0);

    expect(await alarmAt()).toBe(t0 + 5_000);
    await after(5_000);
    expect(calls.map((c) => [c.at, c.attempt])).toEqual([
      [t0, 1],
      [t0 + 5_000, 2],
    ]);
    expect((await deliveries()).map((d) => d.status)).toEqual(["retrying", "ok"]);
  });

  it("counts a throwing deliverer as a retry", async () => {
    answers = [new Error("socket hang up")];
    const t0 = clock.now();
    await enqueue(view("running"));
    await after(0);

    expect(await alarmAt()).toBe(t0 + RETRY_DELAYS_MS[0]);
    expect(await pending()).toEqual([{ run_id: "trg_1", attempt: 1, due_at: t0 + RETRY_DELAYS_MS[0] }]);
    await after(RETRY_DELAYS_MS[0]);
    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect((await deliveries()).map((d) => d.status)).toEqual(["retrying", "ok"]);
  });

  it("disables the sink on fail with disable, and drops later updates without calling the provider", async () => {
    answers = [{ kind: "fail", httpStatus: 410, disable: "webhook_gone" }];
    const t0 = clock.now();
    await enqueue(view("running"));
    await after(0);

    expect(await getSinkConfigWithSecret(env, t, cfg.id)).toMatchObject({ disabledAt: t0, disabledReason: "webhook_gone" });
    expect(await pending()).toEqual([]);

    await enqueue(view("success"));
    await after(OUTBOX_MIN_INTERVAL_MS);
    expect(calls).toHaveLength(1);
    expect(await pending()).toEqual([]);
    expect((await deliveries()).map((d) => [d.attempt, d.status, d.http_status])).toEqual([
      [1, "dropped", 410],
      [1, "dropped", null],
    ]);
  });

  it("drops updates for a deleted sink", async () => {
    await enqueue(view("running"), "snk_deleted");
    await after(0, "snk_deleted");

    expect(calls).toEqual([]);
    expect(await pending("snk_deleted")).toEqual([]);
    expect((await deliveries("snk_deleted")).map((d) => d.status)).toEqual(["dropped"]);
  });

  it("keeps calls to the provider at least OUTBOX_MIN_INTERVAL_MS apart", async () => {
    const t0 = clock.now();
    await enqueue(view("running", "trg_1"));
    await enqueue(view("running", "trg_2"));
    await enqueue(view("running", "trg_3"));
    await after(0);
    expect(calls.map((c) => c.item.runId)).toEqual(["trg_1"]);
    expect(await alarmAt()).toBe(t0 + OUTBOX_MIN_INTERVAL_MS);

    await after(OUTBOX_MIN_INTERVAL_MS - 1);
    expect(calls).toHaveLength(1);
    await after(1);
    await enqueue(view("success", "trg_4"));
    expect(await alarmAt()).toBe(t0 + 2 * OUTBOX_MIN_INTERVAL_MS);
    for (let i = 0; i < 5; i++) await after(OUTBOX_MIN_INTERVAL_MS);

    expect(calls.map((c) => c.item.runId)).toEqual(["trg_1", "trg_2", "trg_3", "trg_4"]);
    const gaps = calls.slice(1).map((c, i) => c.at - (calls[i]?.at ?? 0));
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(OUTBOX_MIN_INTERVAL_MS);
  });
});
