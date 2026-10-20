import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../../src/db/agents";
import { bindAllRepos } from "../../src/db/bindings";
import { recordDelivery } from "../../src/db/deliveries";
import { purgeInstallation, upsertInstallation } from "../../src/db/installations";
import { upsertRepos } from "../../src/db/repos";
import { insertRun, upsertJob } from "../../src/db/runs";
import { tenantDb } from "../../src/db/tenant";
import { addWatch } from "../../src/db/watches";
import { linkWorkspace } from "../../src/db/workspaces";
import { clearTables, columnsOf, schemaTables } from "./helpers";

// Tables that hold no installation data. Adding a table to the schema that is
// neither listed here nor keyed by installation_id or run_id fails the test.
const GLOBAL_TABLES = ["workspaces", "user_links", "slack_events", "ip_rate", "redelivery_cursor", "hook_redeliveries", "oauth_states", "cron_state"];

beforeEach(clearTables);

// Puts at least one row for installation id into every table that holds installation data.
async function seed(id: number): Promise<void> {
  const t = tenantDb(env.DB, id);
  const repoId = id * 10;
  const runId = `run-${id}`;
  const agentId = `agent-${id}`;
  await upsertInstallation(env.DB, { id, account_login: `org${id}`, account_type: "Organization", account_id: id * 10, created_at: 1 });
  await upsertRepos(t, [{ repo_id: repoId, full_name: `org${id}/app`, default_branch: "main" }]);
  await insertAgent(t, {
    agent_id: agentId,
    name: "builder",
    hostname: null,
    os: "linux",
    arch: "amd64",
    credential_hash: `hash-${id}`,
    agent_version: "0.1.0",
    paired_by_github_id: 7,
    paired_at: 1,
  });
  await bindAllRepos(t, agentId);
  await addWatch(t, { repo_id: repoId, team_id: "T1", channel_id: "C1", notify: "normal", alert: "channel", created_by: "U1" });
  await linkWorkspace(t, "T1", "U1", 1);
  await insertRun(t, {
    run_id: runId,
    repo_id: repoId,
    sha: "a".repeat(40),
    ref: "refs/heads/main",
    event: "push",
    pr_number: null,
    env: null,
    attempt: 1,
    trigger_id: `trg-${id}`,
    agent_id: agentId,
    state: "running",
    reason: null,
    author_login: "octocat",
    commit_title: "fix",
    started_at: 1,
    finished_at: null,
    duration_ms: null,
    log_key: null,
  });
  await upsertJob(t, { run_id: runId, name: "test", state: "running", step: "go test", step_index: 1, steps_total: 2, duration_ms: null });
  await recordDelivery(env.DB, {
    delivery_id: `delivery-${id}`,
    received_at: 1,
    expires_at: 2,
    event: "push",
    installation_id: id,
    status: "processed",
    note: null,
  });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO pair_tokens (token_hash, installation_id, created_by_github_id, replaces_agent_id, expires_at, used_at) VALUES (?1, ?2, 7, NULL, 9, NULL)",
    ).bind(`token-${id}`, id),
    env.DB.prepare(
      "INSERT INTO check_runs (installation_id, repo_id, head_sha, name, check_run_id) VALUES (?1, ?2, ?3, 'zeroci', ?4)",
    ).bind(id, repoId, "a".repeat(40), id * 1000),
    env.DB.prepare(
      "INSERT INTO author_cache (installation_id, team_id, key, slack_user_id, expires_at) VALUES (?1, 'T1', 'octocat', 'U9', 9)",
    ).bind(id),
    env.DB.prepare(
      "INSERT INTO author_map (installation_id, team_id, github_login, slack_user_id) VALUES (?1, 'T1', 'octocat', 'U9')",
    ).bind(id),
    env.DB.prepare("INSERT INTO daily_counters (installation_id, day, runs) VALUES (?1, '2025-01-01', 3)").bind(id),
    env.DB.prepare(
      "INSERT INTO fork_approvals (installation_id, repo_id, pr_number, head_sha, attempt, approved_by_github_id, approved_at) VALUES (?1, ?2, 5, ?3, 1, 7, 1)",
    ).bind(id, repoId, "b".repeat(40)),
    env.DB.prepare(
      "INSERT INTO deploy_triggers (installation_id, repo, sha, env, attempt, event, ref, trigger_id, agent_id, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'staging', 1, 'push', 'refs/heads/main', ?4, 'agt', 'sent', 1, 1)",
    ).bind(id, `acme/repo-${id}`, "c".repeat(40), `dt-${id}`),
    env.DB.prepare("INSERT INTO slack_messages (run_id, team_id, channel_id, ts, alert_ts) VALUES (?1, 'T1', 'C1', '1.0', NULL)").bind(runId),
    env.DB.prepare("INSERT INTO slack_job_replies (run_id, team_id, channel_id, job, ts) VALUES (?1, 'T1', 'C1', 'build', '1.1')").bind(runId),
    env.DB.prepare(
      "INSERT INTO deploy_renders (installation_id, run_id, repo, env, sha, slack_channel, slack_ts, check_run_id, state, step, step_index, steps_total, started_at, updated_at) VALUES (?1, ?2, 'acme/repo', 'staging', ?3, 'C1', '1.2', 5, 'running', NULL, NULL, NULL, 1, 1)",
    ).bind(id, runId, "c".repeat(40)),
    env.DB.prepare(
      "INSERT INTO sink_configs (installation_id, id, kind, repo, target, secret_enc, key_version, created_by, created_at) VALUES (?1, ?2, 'webhook', 'acme/repo', 'https://example.com/hook', NULL, NULL, 'agent:agt', 1)",
    ).bind(id, `snk_${id}`),
    env.DB.prepare("INSERT INTO sink_messages (installation_id, sink_id, run_id, external_id, last_hash, updated_at) VALUES (?1, ?2, ?3, NULL, 'h', 1)").bind(
      id,
      `snk_${id}`,
      runId,
    ),
    env.DB.prepare(
      "INSERT INTO sink_deliveries (installation_id, sink_id, delivery_id, run_id, attempt, status, http_status, at) VALUES (?1, ?2, 'dlv', ?3, 1, 'ok', 200, 1)",
    ).bind(id, `snk_${id}`, runId),
  ]);
}

// How the rows of one installation are found in each table; ?1 is the
// installation id, or for run_id the JSON array of its run ids.
type Scope = "installation_id" | "run_id" | "id";

const WHERE_BY_SCOPE: Record<Scope, string> = {
  installation_id: "installation_id = ?1",
  id: "id = ?1",
  run_id: "run_id IN (SELECT value FROM json_each(?1))",
};

async function classifyTables(): Promise<{ scopes: Map<string, Scope>; unclassified: string[] }> {
  const scopes = new Map<string, Scope>();
  const unclassified: string[] = [];
  for (const table of await schemaTables()) {
    const columns = await columnsOf(table);
    if (table === "installations") scopes.set(table, "id");
    else if (columns.includes("installation_id")) scopes.set(table, "installation_id");
    else if (columns.includes("run_id")) scopes.set(table, "run_id");
    else if (!GLOBAL_TABLES.includes(table)) unclassified.push(table);
  }
  return { scopes, unclassified };
}

async function rowsOf(table: string, scope: Scope, id: number, runIds: readonly string[]): Promise<unknown[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${WHERE_BY_SCOPE[scope]} ORDER BY rowid`)
    .bind(scope === "run_id" ? JSON.stringify(runIds) : id)
    .all();
  return results;
}

async function runIdsOf(id: number): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT run_id FROM runs WHERE installation_id = ?1").bind(id).all<{ run_id: string }>();
  return results.map((r) => r.run_id);
}

describe("purgeInstallation", () => {
  it("deletes the installation's rows from every table and leaves other installations unchanged", async () => {
    await seed(1);
    await seed(2);
    const { scopes, unclassified } = await classifyTables();
    expect(unclassified).toEqual([]);

    const runIds = { 1: await runIdsOf(1), 2: await runIdsOf(2) };
    const before = new Map<string, unknown[]>();
    for (const [table, scope] of scopes) {
      const one = await rowsOf(table, scope, 1, runIds[1]);
      const two = await rowsOf(table, scope, 2, runIds[2]);
      expect({ table, seeded: one.length > 0 && two.length > 0 }).toEqual({ table, seeded: true });
      before.set(table, two);
    }

    await purgeInstallation(env.DB, 1);

    for (const [table, scope] of scopes) {
      expect({ table, rows: await rowsOf(table, scope, 1, runIds[1]) }).toEqual({ table, rows: [] });
      expect({ table, rows: await rowsOf(table, scope, 2, runIds[2]) }).toEqual({ table, rows: before.get(table) });
    }
  });
});
