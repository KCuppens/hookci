import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  countRedelivery,
  type DeliveryRow,
  deliveryStatuses,
  markDelivery,
  PENDING_STALE_MS,
  reclaimDelivery,
  recordDelivery,
  redeliveryAttempts,
} from "../../src/db/deliveries";
import { clearTables } from "./helpers";

beforeEach(clearTables);

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function delivery(id: string, expiresAt: number): DeliveryRow {
  return { delivery_id: id, received_at: NOW - HOUR, expires_at: expiresAt, event: "push", installation_id: 1, status: "processed", note: null };
}

describe("recordDelivery", () => {
  it("returns true for a new delivery id and false for a repeat", async () => {
    expect(await recordDelivery(env.DB, delivery("d1", NOW + HOUR))).toBe(true);
    expect(await recordDelivery(env.DB, { ...delivery("d1", NOW + HOUR), status: "failed" })).toBe(false);
    expect(await env.DB.prepare("SELECT status FROM deliveries WHERE delivery_id = 'd1'").first()).toEqual({ status: "processed" });
  });

  it("markDelivery updates the status and note", async () => {
    await recordDelivery(env.DB, delivery("d1", NOW + HOUR));
    await markDelivery(env.DB, "d1", "failed", "github 502");
    expect(await env.DB.prepare("SELECT status, note FROM deliveries WHERE delivery_id = 'd1'").first()).toEqual({
      status: "failed",
      note: "github 502",
    });
  });
});

describe("reclaimDelivery", () => {
  it("records a redelivery over a failed or stale pending delivery, but not a fresh pending or final one", async () => {
    await recordDelivery(env.DB, { ...delivery("failed", NOW + HOUR), status: "failed", note: "agent_do_failed" });
    await recordDelivery(env.DB, { ...delivery("stale", NOW + HOUR), status: "pending" });
    await recordDelivery(env.DB, { ...delivery("fresh", NOW + HOUR), received_at: NOW - PENDING_STALE_MS, status: "pending" });
    await recordDelivery(env.DB, delivery("processed", NOW + HOUR));
    await recordDelivery(env.DB, { ...delivery("dropped", NOW + HOUR), status: "dropped", note: "rate_limited" });
    const redelivery = (id: string): DeliveryRow => ({ ...delivery(id, NOW + 2 * HOUR), received_at: NOW, status: "pending" });

    expect(await reclaimDelivery(env.DB, redelivery("failed"))).toBe(true);
    expect(await reclaimDelivery(env.DB, redelivery("stale"))).toBe(true);
    expect(await reclaimDelivery(env.DB, redelivery("fresh"))).toBe(false);
    expect(await reclaimDelivery(env.DB, redelivery("processed"))).toBe(false);
    expect(await reclaimDelivery(env.DB, redelivery("dropped"))).toBe(false);
    expect(await reclaimDelivery(env.DB, redelivery("unknown"))).toBe(false);

    const { results } = await env.DB.prepare(
      "SELECT delivery_id, received_at, expires_at, status, note FROM deliveries WHERE delivery_id IN ('failed', 'stale') ORDER BY delivery_id",
    ).all();
    expect(results).toEqual([
      { delivery_id: "failed", received_at: NOW, expires_at: NOW + 2 * HOUR, status: "pending", note: null },
      { delivery_id: "stale", received_at: NOW, expires_at: NOW + 2 * HOUR, status: "pending", note: null },
    ]);
    expect(await reclaimDelivery(env.DB, { ...redelivery("stale"), received_at: NOW + 1 })).toBe(false);
  });
});

describe("deliveryStatuses", () => {
  it("returns the recorded status of each id asked for, leaving out unknown ones", async () => {
    await recordDelivery(env.DB, delivery("processed", NOW + HOUR));
    await recordDelivery(env.DB, { ...delivery("dropped", NOW + HOUR), status: "dropped" });
    await recordDelivery(env.DB, { ...delivery("failed", NOW + HOUR), status: "failed" });
    await recordDelivery(env.DB, { ...delivery("fresh", NOW + HOUR), received_at: NOW - PENDING_STALE_MS, status: "pending" });
    await recordDelivery(env.DB, delivery("other", NOW + HOUR));

    expect(await deliveryStatuses(env.DB, ["processed", "dropped", "failed", "fresh", "unknown"], NOW)).toEqual(
      new Map([
        ["processed", "processed"],
        ["dropped", "dropped"],
        ["failed", "failed"],
        ["fresh", "pending"],
      ]),
    );
    expect(await deliveryStatuses(env.DB, [], NOW)).toEqual(new Map());
  });

  it("reads a delivery pending past PENDING_STALE_MS as failed, its handler having been cut off", async () => {
    await recordDelivery(env.DB, { ...delivery("stale", NOW + HOUR), received_at: NOW - PENDING_STALE_MS - 1, status: "pending" });
    expect(await deliveryStatuses(env.DB, ["stale"], NOW)).toEqual(new Map([["stale", "failed"]]));
  });
});

describe("redeliveryAttempts", () => {
  it("counts the redeliveries asked for per guid, leaving out guids never redelivered", async () => {
    await countRedelivery(env.DB, "g-1", NOW);
    await countRedelivery(env.DB, "g-1", NOW + 1);
    await countRedelivery(env.DB, "g-2", NOW);

    expect(await redeliveryAttempts(env.DB, ["g-1", "g-2", "g-3"])).toEqual(
      new Map([
        ["g-1", 2],
        ["g-2", 1],
      ]),
    );
    expect(await redeliveryAttempts(env.DB, [])).toEqual(new Map());
    expect(await env.DB.prepare("SELECT last_at FROM hook_redeliveries WHERE guid = 'g-1'").first()).toEqual({ last_at: NOW + 1 });
  });
});
