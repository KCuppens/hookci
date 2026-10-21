import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getRun, insertRun, listRecentRuns, type NewRun, updateRunState, upsertJob } from "../../src/db/runs";
import { tenantDb } from "../../src/db/tenant";
import { HubError } from "../../src/errors";
import { clearTables } from "./helpers";

beforeEach(clearTables);

function newRun(runId: string): NewRun {
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
  };
}

describe("tenantDb scope guard", () => {
  it.each([
    "SELECT * FROM runs",
    "SELECT * FROM runs WHERE run_id = ?2",
    "SELECT * FROM runs WHERE installation_id = ?2",
    "SELECT * FROM runs WHERE installation_id = ?10",
    "SELECT * FROM runs WHERE installation_id != ?1",
    "INSERT INTO repos (repo_id, installation_id, full_name, default_branch) VALUES (?2, ?1, ?3, ?4)",
    "INSERT INTO repos (installation_id, repo_id, full_name, default_branch) VALUES (?2, ?3, ?4, ?5)",
    "INSERT INTO repos (installation_id, repo_id, full_name, default_branch) VALUES (?1, 1, 'a/b', 'main'), (2, 2, 'c/d', 'main')",
  ])("rejects %s with tenant_scope_missing", async (sql) => {
    const t = tenantDb(env.DB, 1);
    for (const attempt of [() => t.all(sql), () => t.first(sql), () => t.run(sql)]) {
      const err = await attempt().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HubError);
      expect(err).toMatchObject({ code: "tenant_scope_missing", status: 500 });
    }
  });

  it("does not run a rejected statement", async () => {
    const t = tenantDb(env.DB, 1);
    await insertRun(t, newRun("r1"));
    await expect(t.run("DELETE FROM runs")).rejects.toMatchObject({ code: "tenant_scope_missing" });
    expect(await getRun(t, "r1")).not.toBeNull();
  });

  it("accepts a filter on installation_id = ?1 in any spacing, and the runs subquery form", async () => {
    const t = tenantDb(env.DB, 1);
    await insertRun(t, newRun("r1"));
    await upsertJob(t, { run_id: "r1", name: "test", state: "running", step: null, step_index: null, steps_total: null, duration_ms: null });
    expect(await t.first<{ n: number }>("SELECT count(*) AS n FROM runs\n\tWHERE installation_id=?1")).toEqual({ n: 1 });
    expect(
      await t.all<{ name: string }>("SELECT name FROM jobs WHERE run_id IN ( SELECT run_id FROM runs WHERE installation_id = ?1 )"),
    ).toEqual([{ name: "test" }]);
  });
});

describe("tenant isolation", () => {
  it("lists and reads only the installation's own runs", async () => {
    const one = tenantDb(env.DB, 1);
    const two = tenantDb(env.DB, 2);
    await insertRun(one, newRun("one-a"));
    await insertRun(two, newRun("two-a"));
    await insertRun(one, newRun("one-b"));
    await insertRun(two, newRun("two-b"));
    await insertRun(one, newRun("one-c"));

    expect((await listRecentRuns(one)).map((r) => r.run_id)).toEqual(["one-c", "one-b", "one-a"]);
    expect((await listRecentRuns(two)).map((r) => r.run_id)).toEqual(["two-b", "two-a"]);
    expect((await listRecentRuns(one, 2)).map((r) => r.run_id)).toEqual(["one-c", "one-b"]);
    expect((await listRecentRuns(one)).every((r) => r.installation_id === 1)).toBe(true);
    expect(await getRun(two, "one-a")).toBeNull();
  });

  it("cannot update another installation's run or add jobs to it", async () => {
    const one = tenantDb(env.DB, 1);
    const two = tenantDb(env.DB, 2);
    await insertRun(one, newRun("one-a"));

    expect(await updateRunState(two, "one-a", "failed", { reason: "x" })).toBe(false);
    const job = { run_id: "one-a", name: "test", state: "running", step: null, step_index: null, steps_total: null, duration_ms: null };
    expect(await upsertJob(two, job)).toBe(false);
    expect(await getRun(one, "one-a")).toMatchObject({ state: "received", reason: null });
    expect(await one.all("SELECT name FROM jobs WHERE run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1)")).toEqual([]);
  });
});
