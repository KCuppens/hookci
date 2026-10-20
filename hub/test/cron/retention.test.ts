import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import lifecycle from "../../r2-lifecycle.json";
import { purgeExpiredLogs } from "../../src/cron/retention";
import { getCronState } from "../../src/db/cron-state";
import { purgeExpired } from "../../src/db/purge";
import { clearTables } from "../db/helpers";

const DAY = 24 * 3_600_000;

async function logKeys(): Promise<string[]> {
  return (await env.LOGS.list()).objects.map((o) => o.key).sort();
}

beforeEach(async () => {
  await clearTables();
  const { objects } = await env.LOGS.list();
  if (objects.length > 0) await env.LOGS.delete(objects.map((o) => o.key));
});

// R2 stamps `uploaded` with the real time of the put, so the sweep's now
// moves forward instead of the objects moving back.
describe("purgeExpiredLogs", () => {
  it("deletes logs uploaded 15 days ago and keeps logs uploaded 13 days ago", async () => {
    await env.LOGS.put("logs/1/run_a/build.log", "a");
    await env.LOGS.put("other/1/keep.txt", "b");
    const uploaded = Date.now();

    expect(await purgeExpiredLogs(env, uploaded + 13 * DAY)).toEqual({ deleted: 0, done: true });
    expect(await logKeys()).toEqual(["logs/1/run_a/build.log", "other/1/keep.txt"]);

    expect(await purgeExpiredLogs(env, uploaded + 15 * DAY)).toEqual({ deleted: 1, done: true });
    expect(await logKeys()).toEqual(["other/1/keep.txt"]);
  });

  it("sweeps 12 objects in three batches of 5, advancing the cursor", async () => {
    for (let i = 0; i < 12; i++) await env.LOGS.put(`logs/1/run_${String(i).padStart(2, "0")}/test.log`, "x");
    const now = Date.now() + 15 * DAY;

    expect(await purgeExpiredLogs(env, now, { batch: 5 })).toEqual({ deleted: 5, done: false });
    const first = await getCronState(env.DB, "logs");
    expect(first).not.toBe("");
    expect(await purgeExpiredLogs(env, now, { batch: 5 })).toEqual({ deleted: 5, done: false });
    expect(await getCronState(env.DB, "logs")).not.toBe(first);
    expect(await purgeExpiredLogs(env, now, { batch: 5 })).toEqual({ deleted: 2, done: true });
    expect(await getCronState(env.DB, "logs")).toBe("");
    expect(await logKeys()).toEqual([]);
  });
});

describe("purgeExpired sink rows", () => {
  it("deletes sink messages and deliveries older than 14 days and keeps fresh ones", async () => {
    const now = 1_767_225_600_000;
    const old = now - 14 * DAY - 1;
    const fresh = now - 14 * DAY + 1;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sink_messages (installation_id, sink_id, run_id, updated_at) VALUES (1, 's', 'old', ?1), (1, 's', 'fresh', ?2)").bind(old, fresh),
      env.DB.prepare(
        "INSERT INTO sink_deliveries (installation_id, sink_id, delivery_id, run_id, attempt, status, at) VALUES (1, 's', 'old', 'r', 1, 'ok', ?1), (1, 's', 'fresh', 'r', 1, 'ok', ?2)",
      ).bind(old, fresh),
    ]);

    expect(await purgeExpired(env.DB, now)).toBe(2);
    expect((await env.DB.prepare("SELECT run_id FROM sink_messages").all()).results).toEqual([{ run_id: "fresh" }]);
    expect((await env.DB.prepare("SELECT delivery_id FROM sink_deliveries").all()).results).toEqual([{ delivery_id: "fresh" }]);
  });
});

describe("r2-lifecycle.json", () => {
  it("expires logs/ after 14 days", () => {
    expect(lifecycle.rules).toEqual([
      expect.objectContaining({ id: "zeroci-log-retention", enabled: true, conditions: { prefix: "logs/" } }),
    ]);
    expect(lifecycle.rules[0]!.deleteObjectsTransition.condition).toEqual({ type: "Age", maxAge: 14 * 86_400 });
  });
});
