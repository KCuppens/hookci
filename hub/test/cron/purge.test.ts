import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { purgeExpired } from "../../src/db/purge";
import { QUOTAS } from "../../src/quotas";
import { ulid } from "../../src/ulid";
import { clearTables } from "../db/helpers";

// 2026-01-01T00:00:00Z.
const NOW = 1_767_225_600_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RUN_CUTOFF = NOW - QUOTAS.retentionDays * DAY;

async function column(sql: string): Promise<string[]> {
  const { results } = await env.DB.prepare(sql).all<{ v: string }>();
  return results.map((r) => String(r.v));
}

async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

function insertRun(runId: string, triggeredAt: number, sha: string): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO runs (run_id, installation_id, repo_id, sha, ref, event, attempt, trigger_id, state) VALUES (?1, 1, 10, ?2, 'refs/heads/main', 'push', 1, ?3, 'success')",
  ).bind(runId, sha, ulid(triggeredAt));
}

beforeEach(clearTables);

describe("purgeExpired", () => {
  it("keeps rows just inside each retention window and deletes rows just outside it", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO deliveries (delivery_id, received_at, expires_at, event, installation_id, status) VALUES ('in', ?1, ?1, 'push', 1, 'processed'), ('out', ?2, ?2, 'push', 1, 'processed')",
      ).bind(NOW - 7 * DAY, NOW - 7 * DAY - 1),
      env.DB.prepare("INSERT INTO slack_events (event_id, expires_at) VALUES ('in', ?1), ('out', ?2)").bind(NOW, NOW - 1),
      env.DB.prepare(
        "INSERT INTO oauth_states (nonce_hash, kind, payload, expires_at, used_at) VALUES ('in', 'github_link', NULL, ?1, NULL), ('out', 'slack_install', NULL, ?2, NULL)",
      ).bind(NOW, NOW - 1),
      env.DB.prepare(
        "INSERT INTO pair_tokens (token_hash, installation_id, created_by_github_id, expires_at) VALUES ('in', 1, 7, ?1), ('out', 1, 7, ?2)",
      ).bind(NOW - DAY, NOW - DAY - 1),
      env.DB.prepare(
        "INSERT INTO author_cache (installation_id, team_id, key, slack_user_id, expires_at) VALUES (1, 'T1', 'in', 'U1', ?1), (1, 'T1', 'out', NULL, ?2)",
      ).bind(NOW, NOW - 1),
      env.DB.prepare("INSERT INTO ip_rate (bucket, count, window_start) VALUES ('in', 5, ?1), ('out', 5, ?2)").bind(NOW - HOUR, NOW - HOUR - 1),
      env.DB.prepare("INSERT INTO daily_counters (installation_id, day, runs) VALUES (1, '2025-12-30', 3), (1, '2025-12-29', 3)"),
      insertRun("run-in", RUN_CUTOFF, "sha-in"),
      insertRun("run-out", RUN_CUTOFF - 1, "sha-out"),
      env.DB.prepare("INSERT INTO jobs (run_id, name, state) VALUES ('run-in', 'in', 'success'), ('run-out', 'out', 'success')"),
      env.DB.prepare(
        "INSERT INTO slack_messages (run_id, team_id, channel_id, ts) VALUES ('run-in', 'T1', 'C1', 'in'), ('run-out', 'T1', 'C1', 'out')",
      ),
      env.DB.prepare(
        "INSERT INTO slack_job_replies (run_id, team_id, channel_id, job, ts) VALUES ('run-in', 'T1', 'C1', 'build', 'in'), ('run-out', 'T1', 'C1', 'build', 'out')",
      ),
      env.DB.prepare(
        "INSERT INTO check_runs (installation_id, repo_id, head_sha, name, check_run_id) VALUES (1, 10, 'sha-in', 'in', 1), (1, 10, 'sha-out', 'out', 2)",
      ),
    ]);

    expect(await purgeExpired(env.DB, NOW)).toBe(12);

    expect(await column("SELECT delivery_id AS v FROM deliveries")).toEqual(["in"]);
    expect(await column("SELECT event_id AS v FROM slack_events")).toEqual(["in"]);
    expect(await column("SELECT nonce_hash AS v FROM oauth_states")).toEqual(["in"]);
    expect(await column("SELECT token_hash AS v FROM pair_tokens")).toEqual(["in"]);
    expect(await column("SELECT key AS v FROM author_cache")).toEqual(["in"]);
    expect(await column("SELECT bucket AS v FROM ip_rate")).toEqual(["in"]);
    expect(await column("SELECT day AS v FROM daily_counters")).toEqual(["2025-12-30"]);
    expect(await column("SELECT run_id AS v FROM runs")).toEqual(["run-in"]);
    expect(await column("SELECT name AS v FROM jobs")).toEqual(["in"]);
    expect(await column("SELECT ts AS v FROM slack_messages")).toEqual(["in"]);
    expect(await column("SELECT ts AS v FROM slack_job_replies")).toEqual(["in"]);
    expect(await column("SELECT name AS v FROM check_runs")).toEqual(["in"]);
  });

  it("keeps the check runs of a commit that a newer run also built", async () => {
    await env.DB.batch([
      insertRun("run-old", RUN_CUTOFF - DAY, "sha-shared"),
      insertRun("run-new", NOW - HOUR, "sha-shared"),
      env.DB.prepare("INSERT INTO check_runs (installation_id, repo_id, head_sha, name, check_run_id) VALUES (1, 10, 'sha-shared', 'zeroci', 1)"),
    ]);

    expect(await purgeExpired(env.DB, NOW)).toBe(1);
    expect(await column("SELECT run_id AS v FROM runs")).toEqual(["run-new"]);
    expect(await column("SELECT name AS v FROM check_runs")).toEqual(["zeroci"]);
  });

  it("deletes a backlog larger than one 500-row statement", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1201)
      INSERT INTO deliveries (delivery_id, received_at, expires_at, event, installation_id, status)
      SELECT 'd' || i, ?1, ?1, 'push', 1, 'processed' FROM n`,
    )
      .bind(NOW - 8 * DAY)
      .run();

    expect(await purgeExpired(env.DB, NOW)).toBe(1201);
    expect(await count("deliveries")).toBe(0);
  });

  it("caps a table at 5000 rows a tick and deletes a run only after all its jobs are gone", async () => {
    await env.DB.batch([
      insertRun("run-old", RUN_CUTOFF - DAY, "sha-old"),
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5200)
        INSERT INTO jobs (run_id, name, state) SELECT 'run-old', 'job' || i, 'success' FROM n`,
      ),
    ]);

    expect(await purgeExpired(env.DB, NOW)).toBe(5000);
    expect(await count("jobs")).toBe(200);
    expect(await count("runs")).toBe(1);

    expect(await purgeExpired(env.DB, NOW)).toBe(201);
    expect(await count("jobs")).toBe(0);
    expect(await count("runs")).toBe(0);
  });
});
