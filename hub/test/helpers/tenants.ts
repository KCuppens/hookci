// One complete tenant per call: a GitHub installation linked to a Slack
// workspace, with a row in every installation-scoped table, so the security
// suites can seed two and prove neither reaches the other.

import { encryptToken, parseEncKeys } from "../../src/crypto";
import { agentCredentialHash, insertAgent } from "../../src/db/agents";
import { bind } from "../../src/db/bindings";
import { putCheckRun } from "../../src/db/check-runs";
import { recordDelivery } from "../../src/db/deliveries";
import { upsertInstallation } from "../../src/db/installations";
import { upsertRepos } from "../../src/db/repos";
import { insertRun, setJobLog, upsertJob } from "../../src/db/runs";
import { tenantDb } from "../../src/db/tenant";
import { addWatch } from "../../src/db/watches";
import { linkWorkspace, upsertUserLink, upsertWorkspace } from "../../src/db/workspaces";
import type { Env } from "../../src/env";
import { recordApproval } from "../../src/forks/approvals";
import { logKey } from "../../src/logs/keys";
import { createPairToken } from "../../src/pairing/tokens";
import { workspaceAad } from "../../src/slack/tokens";
import { gzip } from "../logs/helpers";

export interface Tenant {
  installationId: number;
  teamId: string;
  /** The Slack user who installed and linked the workspace, linked to githubLogin. */
  slackUserId: string;
  githubUserId: number;
  githubLogin: string;
  channelId: string;
  repoId: number;
  /** `owner/repo` of the installation's one repo. */
  fullName: string;
  agentId: string;
  /** The agent's bearer credential. */
  credential: string;
  /** A failed run of the repo on the agent, with one job whose log is stored. */
  runId: string;
  job: string;
  logKey: string;
  /** The run's commit: installationId in hex, zero-padded to 40 digits, so it is unique per tenant. */
  headSha: string;
  /** The fork pull request with an unspent approval for headSha. */
  prNumber: number;
  /** An unredeemed pair token. */
  pairToken: string;
}

/** Every table holding installation rows; jobs and the slack_* tables hang off runs. */
export const TENANT_TABLES = [
  "runs",
  "jobs",
  "slack_messages",
  "slack_job_replies",
  "repos",
  "repo_bindings",
  "workspace_links",
  "watches",
  "agents",
  "check_runs",
  "fork_approvals",
  "pair_tokens",
  "daily_counters",
  "deliveries",
  "author_cache",
  "author_map",
] as const;

type TenantTable = (typeof TENANT_TABLES)[number];

const RUN_CHILDREN: Partial<Record<TenantTable, true>> = { jobs: true, slack_messages: true, slack_job_replies: true };

/**
 * Seeds installationId linked to teamId with one repo, agent, run, job log,
 * watch, check run, fork approval, pair token, delivery, author mapping and
 * daily counter. Ids derive from installationId, so two tenants never collide.
 */
export async function seedTenant(env: Env, input: { installationId: number; teamId: string }): Promise<Tenant> {
  const { installationId, teamId } = input;
  const n = installationId;
  const tenant = {
    installationId,
    teamId,
    slackUserId: `U0ADMIN${n}`,
    githubUserId: 9000 + n,
    githubLogin: `admin${n}`,
    channelId: `C0CHAN${n}`,
    repoId: n * 10 + 1,
    fullName: `org${n}/api`,
    agentId: `agt_${n}`,
    credential: `zc_agent_agt_${n}`,
    runId: `run_${n}`,
    job: "test",
    logKey: logKey(installationId, `run_${n}`, "test"),
    headSha: n.toString(16).padStart(40, "0"),
    prNumber: n,
  };
  const t = tenantDb(env.DB, installationId);

  await upsertInstallation(env.DB, { id: installationId, account_login: `org${n}`, account_type: "Organization", account_id: installationId * 10, created_at: 1 });
  const { ct, keyVersion } = await encryptToken(parseEncKeys(env.TOKEN_ENC_KEYS), `xoxb-${teamId}`, workspaceAad(teamId));
  await upsertWorkspace(env.DB, {
    team_id: teamId,
    team_name: `Team ${teamId}`,
    bot_user_id: `U0BOT${n}`,
    bot_token_ct: ct,
    key_version: keyVersion,
    installed_by: tenant.slackUserId,
    status: "active",
    created_at: 1,
  });
  await linkWorkspace(t, teamId, tenant.slackUserId, 1);
  await upsertUserLink(env.DB, {
    team_id: teamId,
    slack_user_id: tenant.slackUserId,
    github_user_id: tenant.githubUserId,
    github_login: tenant.githubLogin,
    created_at: 1,
  });
  await upsertRepos(t, [{ repo_id: tenant.repoId, full_name: tenant.fullName, default_branch: "main" }]);

  await insertAgent(t, {
    agent_id: tenant.agentId,
    name: tenant.agentId,
    hostname: `${tenant.agentId}.local`,
    os: "linux",
    arch: "amd64",
    credential_hash: await agentCredentialHash(tenant.credential),
    agent_version: "0.1.0",
    paired_by_github_id: tenant.githubUserId,
    paired_at: 1,
  });
  await bind(t, tenant.repoId, "checks", tenant.agentId);

  await insertRun(t, {
    run_id: tenant.runId,
    repo_id: tenant.repoId,
    sha: tenant.headSha,
    ref: "refs/heads/main",
    event: "push",
    pr_number: null,
    env: null,
    attempt: 1,
    trigger_id: `trg_${n}`,
    agent_id: tenant.agentId,
    state: "failed",
    reason: null,
    author_login: tenant.githubLogin,
    commit_title: "Fix the build",
    started_at: 1,
    finished_at: 2,
    duration_ms: 1,
    log_key: null,
  });
  await upsertJob(t, { run_id: tenant.runId, name: tenant.job, state: "failed", step: null, step_index: null, steps_total: null, duration_ms: 1 });
  const log = await gzip(`tenant ${n} secret log\n`);
  await env.LOGS.put(tenant.logKey, log);
  await setJobLog(t, tenant.runId, tenant.job, { key: tenant.logKey, bytes: log.byteLength, truncated: false });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO slack_messages (run_id, team_id, channel_id, ts) VALUES (?1, ?2, ?3, ?4)").bind(tenant.runId, teamId, tenant.channelId, `${n}.0001`),
    env.DB.prepare("INSERT INTO slack_job_replies (run_id, team_id, channel_id, job, ts) VALUES (?1, ?2, ?3, ?4, ?5)").bind(
      tenant.runId,
      teamId,
      tenant.channelId,
      tenant.job,
      `${n}.0002`,
    ),
    env.DB.prepare("INSERT INTO author_cache (installation_id, team_id, key, slack_user_id, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(
      installationId,
      teamId,
      `login:${tenant.githubLogin}`,
      tenant.slackUserId,
      Number.MAX_SAFE_INTEGER,
    ),
    env.DB.prepare("INSERT INTO author_map (installation_id, team_id, github_login, slack_user_id) VALUES (?1, ?2, ?3, ?4)").bind(
      installationId,
      teamId,
      tenant.githubLogin,
      tenant.slackUserId,
    ),
    env.DB.prepare("INSERT INTO daily_counters (installation_id, day, runs) VALUES (?1, '2026-01-01', 1)").bind(installationId),
  ]);

  await addWatch(t, {
    repo_id: tenant.repoId,
    team_id: teamId,
    channel_id: tenant.channelId,
    notify: "normal",
    alert: "channel",
    created_by: tenant.slackUserId,
  });
  await putCheckRun(t, { repo_id: tenant.repoId, head_sha: tenant.headSha, name: "zeroci", check_run_id: 50_000 + n });
  await recordApproval(t, { repoId: tenant.repoId, prNumber: tenant.prNumber, headSha: tenant.headSha, attempt: 1, approvedByGithubId: tenant.githubUserId });
  await recordDelivery(env.DB, {
    delivery_id: `dlv-${n}`,
    received_at: 1,
    expires_at: Number.MAX_SAFE_INTEGER,
    event: "push",
    installation_id: installationId,
    status: "processed",
    note: null,
  });
  const { token: pairToken } = await createPairToken(env, { installationId, createdByGithubId: tenant.githubUserId });

  return { ...tenant, pairToken };
}

/** Every row installationId holds in each tenant table, by table, in insertion order. */
export async function tenantRows(env: Env, installationId: number): Promise<Record<string, Record<string, unknown>[]>> {
  const results = await env.DB.batch<Record<string, unknown>>(
    TENANT_TABLES.map((table) =>
      env.DB.prepare(
        RUN_CHILDREN[table]
          ? `SELECT * FROM ${table} WHERE run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1) ORDER BY rowid`
          : `SELECT * FROM ${table} WHERE installation_id = ?1 ORDER BY rowid`,
      ).bind(installationId),
    ),
  );
  return Object.fromEntries(TENANT_TABLES.map((table, i) => [table, results[i]?.results ?? []]));
}

/** How many rows of installationId each tenant table holds, by table. */
export async function tenantRowCounts(env: Env, installationId: number): Promise<Record<string, number>> {
  return Object.fromEntries(Object.entries(await tenantRows(env, installationId)).map(([table, rows]) => [table, rows.length]));
}
