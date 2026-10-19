import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type DeliveryRow, markDelivery, purgeExpired, recordDelivery } from "../../src/db/deliveries";
import { clearTables } from "./helpers";

beforeEach(clearTables);

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function delivery(id: string, expiresAt: number): DeliveryRow {
  return { delivery_id: id, received_at: NOW - HOUR, expires_at: expiresAt, event: "push", installation_id: 1, status: "processed", note: null };
}

async function column(sql: string): Promise<string[]> {
  const { results } = await env.DB.prepare(sql).all<{ v: string }>();
  return results.map((r) => r.v);
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

describe("purgeExpired", () => {
  it("removes only expired rows", async () => {
    await recordDelivery(env.DB, delivery("old", NOW - 1));
    await recordDelivery(env.DB, delivery("live", NOW + 1));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO slack_events (event_id, expires_at) VALUES ('old', ?1), ('live', ?2)").bind(NOW - 1, NOW + 1),
      env.DB.prepare(
        "INSERT INTO oauth_states (nonce_hash, kind, payload, expires_at, used_at) VALUES ('old', 'github_link', NULL, ?1, NULL), ('live', 'slack_install', NULL, ?2, NULL)",
      ).bind(NOW - 1, NOW + 1),
      env.DB.prepare(
        "INSERT INTO author_cache (installation_id, team_id, key, slack_user_id, expires_at) VALUES (1, 'T1', 'old', NULL, ?1), (1, 'T1', 'live', 'U1', ?2)",
      ).bind(NOW - 1, NOW + 1),
      env.DB.prepare("INSERT INTO ip_rate (bucket, count, window_start) VALUES ('old', 5, ?1), ('live', 5, ?2)").bind(NOW - 2 * HOUR, NOW - 60_000),
    ]);

    expect(await purgeExpired(env.DB, NOW)).toBe(5);

    expect(await column("SELECT delivery_id AS v FROM deliveries")).toEqual(["live"]);
    expect(await column("SELECT event_id AS v FROM slack_events")).toEqual(["live"]);
    expect(await column("SELECT nonce_hash AS v FROM oauth_states")).toEqual(["live"]);
    expect(await column("SELECT key AS v FROM author_cache")).toEqual(["live"]);
    expect(await column("SELECT bucket AS v FROM ip_rate")).toEqual(["live"]);
  });
});
