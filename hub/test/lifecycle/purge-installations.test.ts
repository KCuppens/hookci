import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCron } from "../../src/cron";
import { purgeDeletedInstallations } from "../../src/cron/purge-installations";
import { insertAgent } from "../../src/db/agents";
import { markDeleted, upsertInstallation } from "../../src/db/installations";
import { upsertRepos } from "../../src/db/repos";
import { insertRun } from "../../src/db/runs";
import { tenantDb } from "../../src/db/tenant";
import { addWatch } from "../../src/db/watches";
import { testClock } from "../clock";
import { clearTables, columnsOf, schemaTables } from "../db/helpers";

const GONE = 42;
const KEPT = 43;
const GRACE = 44;

/** Seeds an installation with a repo, an agent, a run, a watch and two log objects. */
async function seedTenant(id: number): Promise<void> {
  await upsertInstallation(env.DB, { id, account_login: `acct${id}`, account_type: "Organization", created_at: 1 });
  const t = tenantDb(env.DB, id);
  await upsertRepos(t, [{ repo_id: id * 100, full_name: `acct${id}/app`, default_branch: "main" }]);
  await insertAgent(t, {
    agent_id: `agt_${id}`,
    name: "builder",
    hostname: "builder.local",
    os: "linux",
    arch: "amd64",
    credential_hash: `hash-${id}`,
    agent_version: "1.4.0",
    paired_by_github_id: 7,
    paired_at: 1,
  });
  await insertRun(t, {
    run_id: `run_${id}`,
    repo_id: id * 100,
    sha: "1".repeat(40),
    ref: "refs/heads/main",
    event: "push",
    pr_number: null,
    env: null,
    attempt: 1,
    trigger_id: `trg_${id}`,
    agent_id: `agt_${id}`,
    state: "success",
    reason: null,
    author_login: "alice",
    commit_title: "Ship it",
    started_at: 1,
    finished_at: 2,
    duration_ms: 1,
    log_key: `logs/${id}/run_${id}/build.log`,
  });
  await addWatch(t, { repo_id: id * 100, team_id: "T1", channel_id: `C${id}`, notify: "normal", alert: "channel", created_by: "U1" });
  await env.LOGS.put(`logs/${id}/run_${id}/build.log`, "ok");
  await env.LOGS.put(`logs/${id}/run_${id}/test.log`, "ok");
}

let tenantCountSql: string | undefined;

/** The installation's own row plus its rows in every table keyed by installation_id. */
async function tenantRows(id: number): Promise<number> {
  if (tenantCountSql === undefined) {
    const counts = ["(SELECT count(*) FROM installations WHERE id = ?1)"];
    for (const table of await schemaTables()) {
      if ((await columnsOf(table)).includes("installation_id")) counts.push(`(SELECT count(*) FROM ${table} WHERE installation_id = ?1)`);
    }
    tenantCountSql = `SELECT ${counts.join(" + ")} AS n`;
  }
  return (await env.DB.prepare(tenantCountSql).bind(id).first<number>("n"))!;
}

async function logKeys(): Promise<string[]> {
  return (await env.LOGS.list()).objects.map((o) => o.key).sort();
}

beforeEach(async () => {
  await clearTables();
  const { objects } = await env.LOGS.list();
  if (objects.length > 0) await env.LOGS.delete(objects.map((o) => o.key));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("purge_installations cron", () => {
  it("removes a due installation's rows and logs and leaves other tenants intact", async () => {
    const now = testClock.now();
    for (const id of [GONE, KEPT, GRACE, 420]) await seedTenant(id);
    await markDeleted(env.DB, GONE, now - 86_400_001, now - 1);
    await markDeleted(env.DB, GRACE, now - 1000, now + 86_399_000);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await runCron(env, "*/5 * * * *");

    expect(errors.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("purge_installations"))).toEqual([]);
    expect(await tenantRows(GONE)).toBe(0);
    for (const id of [KEPT, GRACE, 420]) expect(await tenantRows(id)).toBe(5);
    expect(await logKeys()).toEqual(
      [KEPT, GRACE, 420].flatMap((id) => [`logs/${id}/run_${id}/build.log`, `logs/${id}/run_${id}/test.log`]).sort(),
    );
  });

  it("purges at most five installations per tick, oldest first", async () => {
    const now = testClock.now();
    const ids = [1, 2, 3, 4, 5, 6, 7];
    for (const id of ids) {
      await upsertInstallation(env.DB, { id, account_login: `acct${id}`, account_type: "User", created_at: 1 });
      await markDeleted(env.DB, id, 1, now - 1000 + id);
    }
    expect(await purgeDeletedInstallations(env, now)).toEqual([1, 2, 3, 4, 5]);
    expect(await purgeDeletedInstallations(env, now)).toEqual([6, 7]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM installations").first("n")).toBe(0);
  });
});
