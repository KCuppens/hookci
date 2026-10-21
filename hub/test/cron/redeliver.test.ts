import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { redeliverFailed } from "../../src/cron/redeliver";
import { getRedeliveryCursor, setRedeliveryCursor } from "../../src/db/cron-state";
import { GitHubClient, type GitHubRequester } from "../../src/github/client";
import type { HookDelivery } from "../../src/github/types";
import { clearTables } from "../db/helpers";
import { createFakeGitHub, serveHookDeliveries } from "../fakes/github";
import type { FakeService } from "../fakes/http";
import { generateAppKey } from "../github/helpers";

const NOW = 1_767_225_600_000;
const HOUR = 3_600_000;

let pem: string;
let gh: FakeService;
let app: GitHubRequester;

function delivery(id: number, guid: string, outcome: "ok" | "failed" | "timeout", ageMs = HOUR): HookDelivery {
  const answer = { ok: { status: "OK", status_code: 200 }, failed: { status: "Invalid HTTP Response: 503", status_code: 503 }, timeout: { status: "timed out", status_code: 0 } }[outcome];
  return {
    id,
    guid,
    delivered_at: new Date(NOW - ageMs).toISOString(),
    redelivery: false,
    ...answer,
    event: "push",
    action: null,
    installation_id: 42,
    repository_id: 1001,
  };
}

/** Ids of the deliveries the fake was asked to redeliver, in order. */
function redeliveredIds(): number[] {
  return gh.calls.flatMap((c) => {
    const m = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(new URL(c.url).pathname);
    return c.method === "POST" && m ? [Number(m[1])] : [];
  });
}

async function recordProcessed(guid: string): Promise<void> {
  await env.DB.prepare("INSERT INTO deliveries (delivery_id, received_at, expires_at, event, installation_id, status) VALUES (?1, ?2, ?3, 'push', 42, 'processed')")
    .bind(guid, NOW - HOUR, NOW + 6 * 24 * HOUR)
    .run();
}

beforeAll(async () => {
  pem = (await generateAppKey()).pem;
});

beforeEach(async () => {
  await clearTables();
  gh = createFakeGitHub();
  app = await new GitHubClient({ ...env, GITHUB_APP_PRIVATE_KEY: pem }, gh.fetcher, () => NOW).app();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redeliverFailed", () => {
  it("redelivers only the failures the hub never handled, then nothing once the cursor has moved", async () => {
    await recordProcessed("g-103");
    serveHookDeliveries(
      gh,
      [delivery(105, "g-105", "ok"), delivery(104, "g-104", "failed"), delivery(103, "g-103", "failed"), delivery(102, "g-102", "timeout"), delivery(101, "g-101", "ok")],
      2,
    );

    expect(await redeliverFailed(env, app, NOW)).toEqual({ scanned: 5, redelivered: 2 });
    expect(redeliveredIds()).toEqual([104, 102]);
    expect(gh.calls.filter((c) => c.method === "GET").map((c) => new URL(c.url).search)).toEqual([
      "?per_page=100",
      "?per_page=100&cursor=2",
      "?per_page=100&cursor=4",
    ]);
    expect(await getRedeliveryCursor(env.DB)).toBe(105);

    gh.calls.length = 0;
    expect(await redeliverFailed(env, app, NOW + 5 * 60_000)).toEqual({ scanned: 0, redelivered: 0 });
    expect(redeliveredIds()).toEqual([]);
    expect(await getRedeliveryCursor(env.DB)).toBe(105);
  });

  it("redelivers a delivery the hub recorded as failed", async () => {
    await env.DB.prepare("INSERT INTO deliveries (delivery_id, received_at, expires_at, event, installation_id, status) VALUES ('g-1', ?1, ?2, 'push', 42, 'failed')")
      .bind(NOW - HOUR, NOW + HOUR)
      .run();
    serveHookDeliveries(gh, [delivery(1, "g-1", "failed")]);
    await redeliverFailed(env, app, NOW);
    expect(redeliveredIds()).toEqual([1]);
  });

  it("redelivers a delivery GitHub saw answered 202 when the hub recorded its handling as failed", async () => {
    await env.DB.prepare("INSERT INTO deliveries (delivery_id, received_at, expires_at, event, installation_id, status) VALUES ('g-1', ?1, ?2, 'push', 42, 'failed')")
      .bind(NOW - HOUR, NOW + HOUR)
      .run();
    serveHookDeliveries(gh, [delivery(1, "g-1", "ok")]);
    await redeliverFailed(env, app, NOW);
    expect(redeliveredIds()).toEqual([1]);
  });

  it("skips a guid whose newest attempt succeeded", async () => {
    serveHookDeliveries(gh, [{ ...delivery(12, "g-a", "ok"), redelivery: true }, delivery(11, "g-b", "failed"), delivery(10, "g-a", "failed")], 1);
    expect(await redeliverFailed(env, app, NOW)).toEqual({ scanned: 3, redelivered: 1 });
    expect(redeliveredIds()).toEqual([11]);
  });

  it("stops at the stored cursor and at deliveries older than 72 hours", async () => {
    await setRedeliveryCursor(env.DB, 7, NOW - HOUR);
    serveHookDeliveries(gh, [delivery(9, "g-9", "failed"), delivery(8, "g-8", "failed", 73 * HOUR), delivery(7, "g-7", "failed"), delivery(6, "g-6", "failed")]);
    expect(await redeliverFailed(env, app, NOW)).toEqual({ scanned: 1, redelivered: 1 });
    expect(redeliveredIds()).toEqual([9]);
    expect(await getRedeliveryCursor(env.DB)).toBe(9);

    await clearTables();
    gh.calls.length = 0;
    expect(await redeliverFailed(env, app, NOW)).toEqual({ scanned: 1, redelivered: 1 });
    expect(redeliveredIds()).toEqual([9]);
  });

  it("sends at most 50 redeliveries a tick and leaves the rest for the next", async () => {
    const failures = Array.from({ length: 60 }, (_, i) => delivery(1000 - i, `g-${1000 - i}`, "failed"));
    serveHookDeliveries(gh, failures);

    expect(await redeliverFailed(env, app, NOW)).toEqual({ scanned: 60, redelivered: 50 });
    expect(redeliveredIds()).toEqual(failures.slice(0, 50).map((d) => d.id));
    expect(await getRedeliveryCursor(env.DB)).toBeNull();

    // The 50 redeliveries reach the hub before the next tick.
    for (const d of failures.slice(0, 50)) await recordProcessed(d.guid);
    gh.calls.length = 0;
    expect(await redeliverFailed(env, app, NOW + 5 * 60_000)).toEqual({ scanned: 60, redelivered: 10 });
    expect(redeliveredIds()).toEqual(failures.slice(50).map((d) => d.id));
    expect(await getRedeliveryCursor(env.DB)).toBe(1000);
  });

  it("keeps the cursor and goes on with the rest when a redelivery request fails", async () => {
    serveHookDeliveries(gh, [delivery(3, "g-3", "failed"), delivery(2, "g-2", "failed"), delivery(1, "g-1", "ok")]);
    gh.respond("POST", "/app/hook/deliveries/3/attempts", () => Response.json({ message: "Validation Failed" }, { status: 422 }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await redeliverFailed(env, app, NOW)).toEqual({ scanned: 3, redelivered: 1 });
    expect(redeliveredIds()).toEqual([3, 2]);
    expect(errors.mock.calls.map((args) => JSON.parse(String(args[0])))).toEqual([
      expect.objectContaining({ task: "redeliver", hook_delivery_id: 3, delivery_id: "g-3" }),
    ]);
    expect(await getRedeliveryCursor(env.DB)).toBeNull();
  });
});
