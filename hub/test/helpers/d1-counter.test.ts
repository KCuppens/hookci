import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertInstallation } from "../../src/db/installations";
import { recordSlackEvent } from "../../src/db/deliveries";
import { clearTables } from "../db/helpers";
import { seedAgent } from "../do/agent-socket";
import { countingD1 } from "./d1-counter";

const real = env.DB;

describe("countingD1", () => {
  beforeEach(clearTables);
  afterEach(() => {
    env.DB = real;
  });

  it("sums rows_written, index entries included, per written table and counts no reads", async () => {
    const counter = countingD1(real);
    // Two rows, each with its primary-key index entry: 4. The UPDATE rewrites one row: 1.
    await counter.db.prepare("INSERT INTO cron_state (key, value, updated_at) VALUES (?1, 'a', 1), (?2, 'b', 1)").bind("k1", "k2").run();
    await counter.db.prepare("UPDATE cron_state SET value = 'c' WHERE key = ?1").bind("k1").run();
    await counter.db.prepare("SELECT * FROM cron_state").all();
    await counter.db.prepare("SELECT value FROM cron_state WHERE key = 'k1'").first("value");
    expect(counter.byTable()).toEqual({ cron_state: 5 });

    counter.reset();
    expect(counter.total()).toBe(0);
  });

  it("counts writes made through first() with RETURNING and through batch()", async () => {
    const counter = countingD1(real);
    expect(await recordSlackEvent(counter.db, "Ev1", 10)).toBe(true);
    expect(await recordSlackEvent(counter.db, "Ev1", 10)).toBe(false);
    await counter.db.batch([
      counter.db.prepare("INSERT INTO cron_state (key, value, updated_at) VALUES ('x', 'y', 1)"),
      counter.db.prepare("DELETE FROM slack_events WHERE event_id = ?1").bind("Ev1"),
    ]);
    // slack_events: the first insert and the delete, each including the event_id and expires_at index entries; the duplicate wrote nothing.
    expect(counter.byTable()).toEqual({ cron_state: 2, slack_events: 4 });
    expect(await counter.db.prepare("SELECT value FROM cron_state WHERE key = 'x'").first("value")).toBe("y");
  });

  it("sees the writes a Durable Object makes once it replaces env.DB", async () => {
    await upsertInstallation(real, { id: 42, account_login: "acme", account_type: "Organization", account_id: 42 * 10, created_at: 1 });
    const agent = await seedAgent(42);
    const counter = countingD1(real);
    env.DB = counter.db;
    const res = await agent.stub.fetch("https://do/trigger", {
      method: "POST",
      headers: { "x-zeroci-agent-id": agent.agentId },
      body: JSON.stringify({
        installationId: 42,
        repoId: 1,
        repo: "acme/api",
        sha: "1".repeat(40),
        ref: "refs/heads/main",
        event: "push",
        authorLogin: "alice",
        commitTitle: "Ship",
        defaultBranch: "main",
        target: "checks",
        trust: "trusted",
      }),
    });
    expect(res.status).toBe(202);
    expect(counter.byTable().runs).toBeGreaterThan(0);
  });

  it("refuses the methods it cannot count", () => {
    const counter = countingD1(real);
    expect(() => counter.db.exec("DELETE FROM runs")).toThrow("countingD1 does not count exec()");
    expect(() => counter.db.prepare("SELECT 1").raw()).toThrow("countingD1 does not count raw()");
  });
});
