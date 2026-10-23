import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { countActiveAgents, getAgentByCredentialHash, insertAgent, listAgents, type NewAgent, revokeAgent, touchAgent } from "../../src/db/agents";
import { bind, bindAllRepos, getBinding, listBindingsForAgent } from "../../src/db/bindings";
import { getInstallation, listPurgeDue, markDeleted, markSuspended, upsertInstallation } from "../../src/db/installations";
import { getRepoByFullName, listRepos, removeRepos, upsertRepos } from "../../src/db/repos";
import { findRunByTrigger, getJobOfRun, getRun, insertRun, type NewRun, updateRunState, upsertJob } from "../../src/db/runs";
import { tenantDb } from "../../src/db/tenant";
import { addWatch, listWatchesForRepo, markWatchBroken, removeWatch } from "../../src/db/watches";
import {
  deleteUserLinksByGithubId,
  getUserLink,
  getWorkspace,
  linkWorkspace,
  listWorkspacesForInstallation,
  setWorkspaceStatus,
  unlinkWorkspace,
  upsertUserLink,
  upsertWorkspace,
  type WorkspaceRow,
} from "../../src/db/workspaces";
import { clearTables } from "./helpers";

beforeEach(clearTables);

const one = tenantDb(env.DB, 1);
const two = tenantDb(env.DB, 2);

function agent(agentId: string): NewAgent {
  return {
    agent_id: agentId,
    name: agentId,
    hostname: "box",
    os: "linux",
    arch: "amd64",
    credential_hash: `hash-${agentId}`,
    agent_version: "0.1.0",
    paired_by_github_id: 7,
    paired_at: 1,
  };
}

function run(runId: string, triggerId: string): NewRun {
  return {
    run_id: runId,
    repo_id: 10,
    sha: "a".repeat(40),
    ref: "refs/heads/main",
    event: "push",
    pr_number: null,
    env: null,
    attempt: 1,
    trigger_id: triggerId,
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

describe("installations", () => {
  it("a reinstall clears deleted_at and purge_after and keeps created_at", async () => {
    await upsertInstallation(env.DB, { id: 1, account_login: "acme", account_type: "Organization", account_id: 10, created_at: 1 });
    await markDeleted(env.DB, 1, 50, 100);
    await upsertInstallation(env.DB, { id: 1, account_login: "acme-renamed", account_type: "Organization", account_id: 11, created_at: 60 });
    expect(await getInstallation(env.DB, 1)).toMatchObject({
      account_login: "acme-renamed",
      account_id: 11,
      created_at: 1,
      deleted_at: null,
      purge_after: null,
    });
  });

  it("markSuspended sets and clears suspended_at", async () => {
    await upsertInstallation(env.DB, { id: 1, account_login: "acme", account_type: "User", account_id: 10, created_at: 1 });
    await markSuspended(env.DB, 1, 5);
    expect(await getInstallation(env.DB, 1)).toMatchObject({ suspended_at: 5 });
    await markSuspended(env.DB, 1, null);
    expect(await getInstallation(env.DB, 1)).toMatchObject({ suspended_at: null });
  });

  it("listPurgeDue returns installations whose purge_after has passed, oldest first", async () => {
    for (const id of [1, 2, 3, 4]) await upsertInstallation(env.DB, { id, account_login: `o${id}`, account_type: "User", account_id: id * 10, created_at: 1 });
    await markDeleted(env.DB, 1, 10, 300);
    await markDeleted(env.DB, 2, 10, 200);
    await markDeleted(env.DB, 3, 10, 999);
    expect(await listPurgeDue(env.DB, 300, 10)).toEqual([2, 1]);
    expect(await listPurgeDue(env.DB, 300, 1)).toEqual([2]);
  });
});

describe("repos", () => {
  it("upserts, finds by full name ignoring case, and removes", async () => {
    await upsertRepos(one, [
      { repo_id: 10, full_name: "Acme/App", default_branch: "main" },
      { repo_id: 11, full_name: "acme/lib", default_branch: "main" },
    ]);
    await upsertRepos(one, [{ repo_id: 10, full_name: "acme/app2", default_branch: "trunk" }]);
    await upsertRepos(two, [{ repo_id: 20, full_name: "other/app", default_branch: "main" }]);

    expect(await getRepoByFullName(one, "ACME/APP2")).toEqual({ installation_id: 1, repo_id: 10, full_name: "acme/app2", default_branch: "trunk" });
    expect(await getRepoByFullName(one, "other/app")).toBeNull();

    await removeRepos(one, [11, 20]);
    expect((await listRepos(one)).map((r) => r.repo_id)).toEqual([10]);
    expect((await listRepos(two)).map((r) => r.repo_id)).toEqual([20]);
  });
});

describe("agents", () => {
  it("touchAgent marks a live agent online and leaves a revoked one alone", async () => {
    await insertAgent(one, agent("a1"));
    await insertAgent(one, agent("a2"));
    expect(await listAgents(one)).toMatchObject([{ agent_id: "a1", status: "offline" }, { agent_id: "a2", status: "offline" }]);

    expect(await revokeAgent(one, "a2", 50)).toBe(true);
    await touchAgent(one, "a1", { protocolVersion: 1, agentVersion: "0.2.0", lastSeenAt: 60 });
    await touchAgent(one, "a2", { protocolVersion: 1, agentVersion: "0.2.0", lastSeenAt: 60 });

    expect(await getAgentByCredentialHash(env.DB, "hash-a1")).toMatchObject({
      installation_id: 1,
      status: "online",
      protocol_version: 1,
      agent_version: "0.2.0",
      last_seen_at: 60,
    });
    expect(await getAgentByCredentialHash(env.DB, "hash-a2")).toMatchObject({ status: "revoked", revoked_at: 50, last_seen_at: null });
    expect(await countActiveAgents(one)).toBe(1);
  });

  it("revokeAgent does not reach another installation's agent", async () => {
    await insertAgent(one, agent("a1"));
    expect(await revokeAgent(two, "a1", 50)).toBe(false);
    expect(await countActiveAgents(one)).toBe(1);
    expect(await countActiveAgents(two)).toBe(0);
  });
});

describe("bindings", () => {
  it("bindAllRepos binds every repo of the installation and replaces earlier agents", async () => {
    await upsertRepos(one, [
      { repo_id: 10, full_name: "acme/app", default_branch: "main" },
      { repo_id: 11, full_name: "acme/lib", default_branch: "main" },
    ]);
    await upsertRepos(two, [{ repo_id: 20, full_name: "other/app", default_branch: "main" }]);
    await bind(one, 10, "checks", "old");
    await bind(one, 10, "deploy:prod", "old");

    await bindAllRepos(one, "a1");

    expect(await listBindingsForAgent(one, "a1")).toEqual([
      { installation_id: 1, repo_id: 10, target: "checks", agent_id: "a1", bound_at: expect.any(Number) },
      { installation_id: 1, repo_id: 11, target: "checks", agent_id: "a1", bound_at: expect.any(Number) },
    ]);
    expect(await getBinding(one, 10, "deploy:prod")).toMatchObject({ agent_id: "old" });
    expect(await getBinding(two, 20, "checks")).toBeNull();
  });
});

describe("runs", () => {
  it("updateRunState sets given columns, clears null ones and keeps omitted ones", async () => {
    await insertRun(one, { ...run("r1", "t1"), reason: "no_agent" });
    expect(await updateRunState(one, "r1", "running", { reason: null, agent_id: "a1", started_at: 5 })).toBe(true);
    expect(await updateRunState(one, "r1", "success", { finished_at: 9, duration_ms: 4 })).toBe(true);
    expect(await getRun(one, "r1")).toMatchObject({ state: "success", reason: null, agent_id: "a1", started_at: 5, finished_at: 9, duration_ms: 4 });
  });

  it("upsertJob updates state and keeps progress columns passed as null", async () => {
    await insertRun(one, run("r1", "t1"));
    await upsertJob(one, { run_id: "r1", name: "test", state: "running", step: "go test", step_index: 2, steps_total: 3, duration_ms: null });
    await upsertJob(one, { run_id: "r1", name: "test", state: "success", step: null, step_index: null, steps_total: null, duration_ms: 70 });
    expect(await one.all("SELECT * FROM jobs WHERE run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1)")).toEqual([
      { run_id: "r1", name: "test", state: "success", step: "go test", step_index: 2, steps_total: 3, duration_ms: 70, step_started_at: expect.any(Number), log_key: null, log_bytes: null, log_truncated: 0, logs_local: 0 },
    ]);
  });

  it("upsertJob restarts the step clock only when the step changes", async () => {
    await insertRun(one, run("r1", "t1"));
    const job = { run_id: "r1", name: "test", state: "running", step_index: 0, steps_total: 2, duration_ms: null };
    await upsertJob(one, { ...job, step: "build" }, 1000);
    await upsertJob(one, { ...job, step: "build" }, 2000);
    await upsertJob(one, { ...job, step: null, step_index: null }, 3000);
    expect(await getJobOfRun(one, "r1", "test")).toMatchObject({ step: "build", step_started_at: 1000 });
    await upsertJob(one, { ...job, step: "push" }, 4000);
    expect(await getJobOfRun(one, "r1", "test")).toMatchObject({ step: "push", step_started_at: 4000 });
  });

  it("findRunByTrigger returns the latest run of the trigger in this installation", async () => {
    await insertRun(one, run("r1", "t1"));
    await insertRun(one, run("r2", "t1"));
    await insertRun(two, run("r3", "t2"));
    expect(await findRunByTrigger(one, "t1")).toMatchObject({ run_id: "r2" });
    expect(await findRunByTrigger(one, "t2")).toBeNull();
  });
});

describe("workspaces", () => {
  const workspace: WorkspaceRow = {
    team_id: "T1",
    team_name: "Acme",
    bot_user_id: "B1",
    bot_token_ct: new Uint8Array([1, 2, 3, 250]),
    key_version: 1,
    installed_by: "U1",
    status: "active",
    created_at: 1,
  };

  it("stores the token ciphertext bytes and lists workspaces linked to the installation", async () => {
    await upsertWorkspace(env.DB, workspace);
    await upsertWorkspace(env.DB, { ...workspace, team_id: "T2", team_name: "Other" });
    await linkWorkspace(one, "T1", "U1", 1);
    await linkWorkspace(two, "T2", "U1", 1);

    expect(await getWorkspace(env.DB, "T1")).toEqual(workspace);
    expect(await listWorkspacesForInstallation(one)).toEqual([workspace]);

    await setWorkspaceStatus(env.DB, "T1", "uninstalled");
    expect(await getWorkspace(env.DB, "T1")).toMatchObject({ status: "uninstalled" });
    await unlinkWorkspace(one, "T1");
    expect(await listWorkspacesForInstallation(one)).toEqual([]);
  });

  it("deleteUserLinksByGithubId removes the user's links in every team", async () => {
    await upsertUserLink(env.DB, { team_id: "T1", slack_user_id: "U1", github_user_id: 7, github_login: "octo", created_at: 1 });
    await upsertUserLink(env.DB, { team_id: "T2", slack_user_id: "U5", github_user_id: 7, github_login: "octo", created_at: 1 });
    await upsertUserLink(env.DB, { team_id: "T1", slack_user_id: "U2", github_user_id: 8, github_login: "cat", created_at: 1 });

    expect(await deleteUserLinksByGithubId(env.DB, 7)).toBe(2);
    expect(await getUserLink(env.DB, "T1", "U1")).toBeNull();
    expect(await getUserLink(env.DB, "T1", "U2")).toMatchObject({ github_login: "cat" });
  });
});

describe("watches", () => {
  const watch = { repo_id: 10, team_id: "T1", channel_id: "C1", notify: "normal", alert: "channel", created_by: "U1" } as const;

  it("markWatchBroken breaks the channel's watches in every installation and re-watching reactivates", async () => {
    await addWatch(one, watch);
    await addWatch(two, { ...watch, repo_id: 20 });
    await addWatch(one, { ...watch, channel_id: "C2" });

    expect(await markWatchBroken(env.DB, "T1", "C1", "channel_not_found")).toEqual(["U1"]);
    expect(await markWatchBroken(env.DB, "T1", "C1", "is_archived")).toEqual([]);
    expect(await listWatchesForRepo(two, 20)).toMatchObject([{ status: "broken", broken_reason: "channel_not_found" }]);
    expect(await listWatchesForRepo(one, 10)).toMatchObject([
      { channel_id: "C1", status: "broken" },
      { channel_id: "C2", status: "active" },
    ]);

    await addWatch(one, { ...watch, notify: "quiet" });
    expect(await listWatchesForRepo(one, 10)).toMatchObject([{ channel_id: "C1", status: "active", broken_reason: null, notify: "quiet" }, { channel_id: "C2" }]);
    expect(await removeWatch(one, 10, "T1", "C1")).toBe(true);
    expect(await removeWatch(one, 10, "T1", "C1")).toBe(false);
  });
});
