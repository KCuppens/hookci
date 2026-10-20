import { describe, expect, it } from "vitest";
import { type Buckets, coalesce, nextWakeAt, pickNext, type SlackCall, type SlackPriority, TokenBucket } from "../../src/do/slack-queue";

function call(id: string, fields: Partial<SlackCall> = {}): SlackCall {
  return { id, method: "chat.update", body: { text: id }, priority: "normal", enqueuedAt: 0, attempts: 0, ...fields };
}

function buckets(now = 0, fields: Partial<Buckets> = {}): Buckets {
  return { workspace: new TokenBucket(40, 40 / 60_000, now), channels: new Map(), pausedUntil: 0, ...fields };
}

describe("TokenBucket", () => {
  it("allows exactly 40 takes at t=0, denies the 41st and allows one more after 1500 ms", () => {
    const bucket = new TokenBucket(40, 40 / 60_000, 0);
    for (let i = 0; i < 40; i++) expect(bucket.take(0)).toBe(true);
    expect(bucket.take(0)).toBe(false);
    expect(bucket.nextAvailableAt(0)).toBe(1500);
    expect(bucket.take(1499)).toBe(false);
    expect(bucket.take(1500)).toBe(true);
    expect(bucket.take(1500)).toBe(false);
  });

  it("refills no further than its capacity", () => {
    const bucket = new TokenBucket(1, 1 / 1000, 0);
    expect(bucket.take(0)).toBe(true);
    expect(bucket.take(10_000)).toBe(true);
    expect(bucket.take(10_000)).toBe(false);
    expect(bucket.nextAvailableAt(10_000)).toBe(11_000);
  });

  it("counts spends below zero as a debt paid back before the next take", () => {
    const bucket = new TokenBucket(1, 1 / 1000, 0);
    bucket.spend(0);
    bucket.spend(0);
    expect(bucket.nextAvailableAt(0)).toBe(2000);
    expect(bucket.take(1999)).toBe(false);
    expect(bucket.take(2000)).toBe(true);
  });

  it("treats a clock that went backwards as no time passed", () => {
    const bucket = new TokenBucket(1, 1 / 1000, 50_000);
    expect(bucket.take(50_000)).toBe(true);
    expect(bucket.nextAvailableAt(0)).toBe(1000);
    expect(bucket.take(1000)).toBe(true);
  });
});

describe("coalesce", () => {
  it("leaves one call per key whose body is the last update's", () => {
    let queue: SlackCall[] = [call("other", { coalesceKey: "C1:2.0" })];
    for (let i = 1; i <= 5; i++) queue = coalesce(queue, call(`u${i}`, { coalesceKey: "C1:1.0", enqueuedAt: i, body: { text: `update ${i}` } }));
    const merged = queue.filter((c) => c.coalesceKey === "C1:1.0");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "u5", body: { text: "update 5" }, enqueuedAt: 1 });
    expect(queue.map((c) => c.id)).toEqual(["other", "u5"]);
  });

  it("keeps the higher priority and the queued call's attempts and backoff", () => {
    const queued = call("a", { coalesceKey: "k", priority: "terminal", attempts: 2, notBefore: 9 });
    const [merged] = coalesce([queued], call("b", { coalesceKey: "k", priority: "normal", enqueuedAt: 5 }));
    expect(merged).toMatchObject({ id: "b", priority: "terminal", attempts: 2, notBefore: 9, enqueuedAt: 0 });
  });

  it("appends calls without a key and does not change the queue it was given", () => {
    const queue = [call("a")];
    expect(coalesce(queue, call("b")).map((c) => c.id)).toEqual(["a", "b"]);
    expect(queue.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("pickNext", () => {
  const normals = Array.from({ length: 10 }, (_, i) => call(`n${i}`, { enqueuedAt: i }));

  it("sends a terminal update enqueued after 10 normal calls first", () => {
    expect(pickNext([...normals, call("t", { priority: "terminal", enqueuedAt: 10 })], buckets(), 100)?.id).toBe("t");
  });

  it("sends an alert before a terminal update", () => {
    const priorities: [string, SlackPriority][] = [
      ["t", "terminal"],
      ["a", "alert"],
    ];
    const queue = [...normals, ...priorities.map(([id, priority], i) => call(id, { priority, enqueuedAt: 20 + i }))];
    expect(pickNext(queue, buckets(), 100)?.id).toBe("a");
  });

  it("sends the earliest enqueued call of one priority", () => {
    expect(pickNext([call("late", { enqueuedAt: 5 }), call("early", { enqueuedAt: 1 })], buckets(), 100)?.id).toBe("early");
  });

  it("skips posts to a channel whose bucket is empty but not other calls", () => {
    const channel = new TokenBucket(1, 1 / 1000, 0);
    channel.take(0);
    const post = call("post", { method: "chat.postMessage", channel: "C1", priority: "alert" });
    const update = call("update", { channel: "C1", enqueuedAt: 1 });
    const b = buckets(0, { channels: new Map([["C1", channel]]) });
    expect(pickNext([post, update], b, 500)?.id).toBe("update");
    expect(pickNext([post], b, 500)).toBeNull();
    expect(nextWakeAt([post], b, 500)).toBe(1000);
    expect(pickNext([post], b, 1000)?.id).toBe("post");
  });

  it("returns null while paused or the workspace bucket is empty", () => {
    expect(pickNext([call("a")], buckets(0, { pausedUntil: 7000 }), 6999)).toBeNull();
    expect(nextWakeAt([call("a")], buckets(0, { pausedUntil: 7000 }), 6999)).toBe(7000);
    const empty = buckets();
    for (let i = 0; i < 40; i++) empty.workspace.take(0);
    expect(pickNext([call("a")], empty, 0)).toBeNull();
    expect(nextWakeAt([call("a")], empty, 0)).toBe(1500);
  });

  it("waits out a call's retry backoff", () => {
    const queue = [call("a", { notBefore: 2000 })];
    expect(pickNext(queue, buckets(), 1999)).toBeNull();
    expect(nextWakeAt(queue, buckets(), 1999)).toBe(2000);
    expect(pickNext(queue, buckets(), 2000)?.id).toBe("a");
  });

  it("has no wake time for an empty queue", () => {
    expect(nextWakeAt([], buckets(), 0)).toBeNull();
  });
});
