import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type DeliveryRow, deliveryStatuses, markDelivery, recordDelivery } from "../../src/db/deliveries";
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

describe("deliveryStatuses", () => {
  it("returns the recorded status of each id asked for, leaving out unknown ones", async () => {
    await recordDelivery(env.DB, delivery("processed", NOW + HOUR));
    await recordDelivery(env.DB, { ...delivery("dropped", NOW + HOUR), status: "dropped" });
    await recordDelivery(env.DB, { ...delivery("failed", NOW + HOUR), status: "failed" });
    await recordDelivery(env.DB, delivery("other", NOW + HOUR));

    expect(await deliveryStatuses(env.DB, ["processed", "dropped", "failed", "unknown"])).toEqual(
      new Map([
        ["processed", "processed"],
        ["dropped", "dropped"],
        ["failed", "failed"],
      ]),
    );
    expect(await deliveryStatuses(env.DB, [])).toEqual(new Map());
  });
});
