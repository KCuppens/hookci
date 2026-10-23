import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeExpired } from "../../src/db/purge";
import { acceptRun, getRun, insertRun, listRecentRuns, type NewRun, updateRunState } from "../../src/db/runs";
import { type TenantDb, tenantDb } from "../../src/db/tenant";
import { QUOTAS } from "../../src/quotas";
import { ulid } from "../../src/ulid";
import { clearTables } from "./helpers";

const A = 1;
const B = 2;
// 2026-01-01T00:00:00Z.
const NOW = 1_767_225_600_000;
const DAY = 86_400_000;

beforeEach(clearTables);

function newRun(runId: string, over: Partial<NewRun> = {}): NewRun {
  return {
    run_id: runId,
    repo_id: 100,
    sha: "a".repeat(40),
    ref: "refs/heads/main",
    event: "push",
    pr_number: null,
    env: null,
    attempt: 1,
    trigger_id: `trg-${runId}`,
    agent_id: null,
    state: "received",
    reason: null,
    author_login: null,
    commit_title: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    log_key: null,
    ...over,
  };
}

async function numbers(t: TenantDb, ...runIds: string[]): Promise<(number | undefined)[]> {
  return Promise.all(runIds.map(async (id) => (await getRun(t, id))?.run_number));
}

describe("run_number", () => {
  it("numbers an installation's runs 1, 2, 3 in the order they are recorded", async () => {
    const t = tenantDb(env.DB, A);
    for (const id of ["r1", "r2", "r3"]) await insertRun(t, newRun(id));

    expect((await listRecentRuns(t, [100], 50)).map((r) => [r.run_id, r.run_number])).toEqual([
      ["r3", 3],
      ["r2", 2],
      ["r1", 1],
    ]);
  });

  it("numbers two installations independently", async () => {
    const a = tenantDb(env.DB, A);
    const b = tenantDb(env.DB, B);
    await insertRun(a, newRun("a1"));
    await insertRun(a, newRun("a2"));
    await insertRun(b, newRun("b1"));
    await insertRun(a, newRun("a3"));
    await insertRun(b, newRun("b2"));

    expect(await numbers(a, "a1", "a2", "a3")).toEqual([1, 2, 3]);
    expect(await numbers(b, "b1", "b2")).toEqual([1, 2]);
  });

  it("gives runs created at the same time different numbers", async () => {
    const a = tenantDb(env.DB, A);
    const b = tenantDb(env.DB, B);
    const ids = Array.from({ length: 12 }, (_, i) => `r${i}`);
    await Promise.all(ids.flatMap((id) => [insertRun(a, newRun(`a-${id}`)), insertRun(b, newRun(`b-${id}`))]));

    for (const t of [a, b]) {
      const all = await listRecentRuns(t, [100], 50);
      expect(all.map((r) => r.run_number).sort((x, y) => x - y)).toEqual(ids.map((_, i) => i + 1));
    }
  });

  it("keeps the number when the run changes state or the agent accepts it under its own id", async () => {
    const t = tenantDb(env.DB, A);
    await insertRun(t, newRun("r1"));
    await insertRun(t, newRun("r2"));
    await acceptRun(t, "trg-r2", "agent-run-2", "agent-1");
    await updateRunState(t, "agent-run-2", "running", { started_at: NOW });
    await updateRunState(t, "r1", "pending", { reason: "daily_cap" });

    expect(await numbers(t, "r1", "agent-run-2")).toEqual([1, 2]);
  });

  it("numbers a retry of the same trigger as a new run", async () => {
    const t = tenantDb(env.DB, A);
    await insertRun(t, newRun("r1", { trigger_id: "trg" }));
    await insertRun(t, newRun("r2", { trigger_id: "trg", attempt: 2 }));

    expect(await numbers(t, "r1", "r2")).toEqual([1, 2]);
  });

  it("keeps counting up after retention deletes the oldest runs", async () => {
    const t = tenantDb(env.DB, A);
    const old = NOW - (QUOTAS.retentionDays + 1) * DAY;
    await insertRun(t, newRun("r1", { trigger_id: ulid(old) }), old);
    await insertRun(t, newRun("r2", { trigger_id: ulid(old + 1) }), old + 1);
    await insertRun(t, newRun("r3", { trigger_id: ulid(NOW) }), NOW);

    await purgeExpired(env.DB, NOW);
    expect(await numbers(t, "r1", "r2", "r3")).toEqual([undefined, undefined, 3]);

    await insertRun(t, newRun("r4", { trigger_id: ulid(NOW + 1) }), NOW + 1);
    expect(await numbers(t, "r4")).toEqual([4]);
  });

  it("is unique within an installation: a repeated number fails loudly", async () => {
    const a = tenantDb(env.DB, A);
    await insertRun(a, newRun("a1"));
    await insertRun(a, newRun("a2"));
    await insertRun(tenantDb(env.DB, B), newRun("b1"));

    await expect(env.DB.prepare("UPDATE runs SET run_number = 1 WHERE run_id = 'a2'").run()).rejects.toThrow(
      /UNIQUE constraint failed: runs\.installation_id, runs\.run_number/,
    );
    await expect(env.DB.prepare("UPDATE runs SET run_number = 2 WHERE run_id = 'b1'").run()).resolves.toBeDefined();
  });
});

describe("run_number collisions", () => {
  const COLLISION = "D1_ERROR: UNIQUE constraint failed: runs.installation_id, runs.run_number: SQLITE_CONSTRAINT";

  /** A tenant whose first `failures` statements throw message before the real database sees them. */
  function failing(t: TenantDb, failures: number, message: string): { t: TenantDb; calls: () => number } {
    let calls = 0;
    const run: TenantDb["run"] = async (sql, ...binds) => {
      calls++;
      if (calls <= failures) throw new Error(message);
      return t.run(sql, ...binds);
    };
    return { t: { ...t, run }, calls: () => calls };
  }

  it("tries again after a run_number collision and takes the next free number", async () => {
    const t = tenantDb(env.DB, A);
    await insertRun(t, newRun("r1"));
    const stub = failing(t, 2, COLLISION);

    await insertRun(stub.t, newRun("r2"));

    expect(stub.calls()).toBe(3);
    expect(await numbers(t, "r1", "r2")).toEqual([1, 2]);
  });

  it("throws the collision once its attempts are used up, leaving no run", async () => {
    const t = tenantDb(env.DB, A);
    const stub = failing(t, 10, COLLISION);

    await expect(insertRun(stub.t, newRun("r1"))).rejects.toThrow(/run_number/);

    expect(stub.calls()).toBe(3);
    expect(await getRun(t, "r1")).toBeNull();
  });

  it("does not retry any other error", async () => {
    const t = tenantDb(env.DB, A);
    const stub = failing(t, 1, "D1_ERROR: UNIQUE constraint failed: runs.run_id: SQLITE_CONSTRAINT");

    await expect(insertRun(stub.t, newRun("r1"))).rejects.toThrow(/runs\.run_id/);

    expect(stub.calls()).toBe(1);
  });

  it("does not hide a duplicate run_id behind a retry", async () => {
    const t = tenantDb(env.DB, A);
    await insertRun(t, newRun("r1"));

    await expect(insertRun(t, newRun("r1", { trigger_id: "other" }))).rejects.toThrow(/UNIQUE constraint failed: runs\.run_id/);
    expect(await numbers(t, "r1")).toEqual([1]);
  });
});

describe("created_at", () => {
  it("is the time given to insertRun", async () => {
    const t = tenantDb(env.DB, A);
    await insertRun(t, newRun("r1"), NOW);

    expect((await getRun(t, "r1"))?.created_at).toBe(NOW);
  });

  it("is the wall clock when no time is given", async () => {
    const t = tenantDb(env.DB, A);
    const before = Date.now();
    await insertRun(t, newRun("r1"));
    const after = Date.now();

    const createdAt = (await getRun(t, "r1"))?.created_at ?? 0;
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(after);
  });

  it("does not change when the run does", async () => {
    const t = tenantDb(env.DB, A);
    await insertRun(t, newRun("r1"), NOW);
    await updateRunState(t, "r1", "running", { started_at: NOW + 5000 });

    expect((await getRun(t, "r1"))?.created_at).toBe(NOW);
  });
});

describe("migration 0029_run_number", () => {
  // The migration is replayed on a scratch table with the columns it reads, as
  // the runs table was before it: its statements with "runs" renamed.
  const SCRATCH = "legacy_runs";

  beforeEach(async () => {
    await env.DB.prepare(`CREATE TABLE ${SCRATCH} (run_id TEXT PRIMARY KEY, installation_id INTEGER NOT NULL, trigger_id TEXT NOT NULL)`).run();
  });

  afterEach(async () => {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${SCRATCH}`).run();
  });

  async function seed(rows: [runId: string, installationId: number, triggerId: string][]): Promise<void> {
    await env.DB.batch(
      rows.map(([runId, installationId, triggerId]) =>
        env.DB.prepare(`INSERT INTO ${SCRATCH} (run_id, installation_id, trigger_id) VALUES (?1, ?2, ?3)`).bind(runId, installationId, triggerId),
      ),
    );
  }

  async function migrate(): Promise<void> {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name === "0029_run_number.sql");
    expect(migration).toBeDefined();
    await env.DB.batch(migration!.queries.map((q) => env.DB.prepare(q.replaceAll("runs", SCRATCH))));
  }

  async function stored(): Promise<Record<string, { run_number: number; created_at: number }>> {
    const { results } = await env.DB.prepare(`SELECT run_id, run_number, created_at FROM ${SCRATCH}`).all<{ run_id: string; run_number: number; created_at: number }>();
    return Object.fromEntries(results.map((r) => [r.run_id, { run_number: r.run_number, created_at: r.created_at }]));
  }

  it("numbers each installation's runs from 1 in trigger_id order, whatever order they were stored in", async () => {
    await seed([
      ["a-late", A, ulid(3000)],
      ["a-early", A, ulid(1000)],
      ["b-only", B, ulid(500)],
      ["a-mid", A, ulid(2000)],
      ["b-after", B, ulid(9000)],
    ]);

    await migrate();

    const rows = await stored();
    expect(Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, r.run_number]))).toEqual({
      "a-early": 1,
      "a-mid": 2,
      "a-late": 3,
      "b-only": 1,
      "b-after": 2,
    });
  });

  it("breaks a tie between runs of one trigger by the order they were stored in", async () => {
    const trigger = ulid(1000);
    await seed([
      ["first", A, trigger],
      ["second", A, trigger],
      ["third", A, trigger],
    ]);

    await migrate();

    const rows = await stored();
    expect([rows.first?.run_number, rows.second?.run_number, rows.third?.run_number]).toEqual([1, 2, 3]);
  });

  it("dates each run from the time in its trigger_id ULID", async () => {
    await seed([
      ["now", A, ulid(NOW)],
      ["epoch", A, ulid(0)],
      ["max", A, ulid(2 ** 48 - 1)],
    ]);

    await migrate();

    const rows = await stored();
    expect(rows.now?.created_at).toBe(NOW);
    expect(rows.epoch?.created_at).toBe(0);
    expect(rows.max?.created_at).toBe(2 ** 48 - 1);
  });

  it("leaves created_at 0 when trigger_id is not a ULID, and still numbers the run", async () => {
    await seed([
      ["short", A, "t"],
      ["upper", A, ulid(NOW).toUpperCase()],
      ["beyond", A, `z${ulid(NOW).slice(1)}`],
      ["symbol", A, `${ulid(NOW).slice(0, 5)}u${ulid(NOW).slice(6)}`],
    ]);

    await migrate();

    const rows = await stored();
    expect(Object.values(rows).map((r) => r.created_at)).toEqual([0, 0, 0, 0]);
    expect(Object.values(rows).map((r) => r.run_number).sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);
  });

  it("ends with a unique index on (installation_id, run_number)", async () => {
    await seed([
      ["a1", A, ulid(1000)],
      ["b1", B, ulid(1000)],
    ]);
    await migrate();

    await expect(env.DB.prepare(`INSERT INTO ${SCRATCH} (run_id, installation_id, trigger_id, run_number) VALUES ('a2', ${A}, 'x', 1)`).run()).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(env.DB.prepare(`INSERT INTO ${SCRATCH} (run_id, installation_id, trigger_id, run_number) VALUES ('a3', ${A}, 'x', 2)`).run()).resolves.toBeDefined();
  });

  it("also leaves the live runs table with both columns and the index", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('runs') WHERE name IN ('created_at', 'run_number') ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["created_at", "run_number"]);
    const index = await env.DB.prepare("SELECT \"unique\" AS u FROM pragma_index_list('runs') WHERE name = 'runs_installation_run_number'").first<{ u: number }>();
    expect(index?.u).toBe(1);
  });
});
