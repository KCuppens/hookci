import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex, hmacSha256 } from "../../src/crypto";
import { insertAgent } from "../../src/db/agents";
import { bind } from "../../src/db/bindings";
import { putCheckRun } from "../../src/db/check-runs";
import { upsertInstallation } from "../../src/db/installations";
import { upsertRepos } from "../../src/db/repos";
import { insertRun } from "../../src/db/runs";
import { type TenantDb, tenantDb } from "../../src/db/tenant";
import { addWatch } from "../../src/db/watches";
import type { Repository } from "../../src/github/types";
import worker from "../../src/index";
import { S } from "../../src/strings";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { formField, useQueueWorld } from "../do/slack-queue-world";
import { createFakeGitHub, serveInstallationTokens } from "../fakes/github";
import { generateAppKey } from "../github/helpers";
import added from "../fixtures/github/installation_repositories.added.json";
import removed from "../fixtures/github/installation_repositories.removed.json";

const INSTALLATION = 42;

type Row = Record<string, unknown>;

async function deliver(payload: unknown): Promise<string> {
  const id = crypto.randomUUID();
  const body = JSON.stringify(payload);
  const headers = new Headers({
    "content-type": "application/json",
    "x-github-event": "installation_repositories",
    "x-github-delivery": id,
    "x-hub-signature-256": `sha256=${hex(await hmacSha256(env.GITHUB_WEBHOOK_SECRET, body))}`,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://hub.test/github/webhook", { method: "POST", headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(202);
  return id;
}

async function rows(sql: string): Promise<Row[]> {
  return (await env.DB.prepare(sql).all<Row>()).results;
}

function addedBy(senderId: number) {
  return { ...added, sender: { ...added.sender, id: senderId } };
}

async function pair(t: TenantDb, agentId: string, pairedBy: number, pairedAt: number): Promise<void> {
  await insertAgent(t, {
    agent_id: agentId,
    name: agentId,
    hostname: `${agentId}.local`,
    os: "linux",
    arch: "amd64",
    credential_hash: `hash-${agentId}`,
    agent_version: "1.4.0",
    paired_by_github_id: pairedBy,
    paired_at: pairedAt,
  });
}

function repo(id: number, name: string): Repository {
  return { id, name, full_name: `acme/${name}`, private: true, default_branch: "main", archived: false, owner: { id: 9, login: "acme", type: "Organization" } };
}

let t: TenantDb;

beforeEach(async () => {
  await clearTables();
  await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", account_id: INSTALLATION * 10, created_at: 1 });
  t = tenantDb(env.DB, INSTALLATION);
});

describe("installation_repositories added", () => {
  const restore: (() => void)[] = [];

  beforeEach(async () => {
    const gh = createFakeGitHub();
    serveInstallationTokens(gh, testClock.now());
    const listed = [repo(1001, "widgets"), repo(2001, "gadgets"), repo(2002, "sprockets")];
    gh.respond("GET", "/installation/repositories", () => Response.json({ total_count: listed.length, repositories: listed }));
    const saved = { fetcher: env.__TEST_FETCHER, key: env.GITHUB_APP_PRIVATE_KEY };
    env.__TEST_FETCHER = gh.fetcher;
    env.GITHUB_APP_PRIVATE_KEY = (await generateAppKey()).pem;
    restore.push(() => {
      env.__TEST_FETCHER = saved.fetcher;
      env.GITHUB_APP_PRIVATE_KEY = saved.key;
    });
    await pair(t, "agt_a", 1, 10);
    await pair(t, "agt_b", 1, 20);
    await pair(t, "agt_c", 2, 30);
  });

  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  it("binds the added repos to the sender's most recently paired agent", async () => {
    await deliver(addedBy(1));
    expect(await rows("SELECT repo_id, full_name, default_branch FROM repos ORDER BY repo_id")).toEqual([
      { repo_id: 2001, full_name: "acme/gadgets", default_branch: "main" },
      { repo_id: 2002, full_name: "acme/sprockets", default_branch: "main" },
    ]);
    expect(await rows("SELECT repo_id, target, agent_id FROM repo_bindings ORDER BY repo_id")).toEqual([
      { repo_id: 2001, target: "checks", agent_id: "agt_b" },
      { repo_id: 2002, target: "checks", agent_id: "agt_b" },
    ]);
  });

  it("binds to the installation's most recently paired agent when the sender paired none", async () => {
    await deliver(addedBy(3));
    expect(await rows("SELECT DISTINCT agent_id FROM repo_bindings")).toEqual([{ agent_id: "agt_c" }]);
  });

  it("stores the repos unbound when the installation has no agent", async () => {
    await env.DB.prepare("DELETE FROM agents").run();
    await deliver(addedBy(1));
    expect(await rows("SELECT repo_id FROM repos ORDER BY repo_id")).toEqual([{ repo_id: 2001 }, { repo_id: 2002 }]);
    expect(await rows("SELECT * FROM repo_bindings")).toEqual([]);
  });

  it("stores repository_selection all from the payload", async () => {
    await deliver({ ...addedBy(1), repository_selection: "all" });
    expect(await rows("SELECT repository_selection FROM installations WHERE id = 42")).toEqual([{ repository_selection: "all" }]);
  });

  it("drops a payload with an unknown repository_selection and changes nothing", async () => {
    await deliver({ ...addedBy(1), repository_selection: "bogus" });
    expect(await rows("SELECT repository_selection FROM installations WHERE id = 42")).toEqual([{ repository_selection: null }]);
    expect(await rows("SELECT repo_id FROM repos")).toEqual([]);
  });
});

describe("installation_repositories removed", () => {
  const world = useQueueWorld();

  beforeEach(async () => {
    world.slack.respond("POST", "/api/chat.postMessage", () => Response.json({ ok: true, ts: "1.0" }));
    await upsertRepos(t, [
      { repo_id: 1001, full_name: "acme/widgets", default_branch: "main" },
      { repo_id: 1002, full_name: "acme/gizmos", default_branch: "main" },
      { repo_id: 1003, full_name: "acme/kept", default_branch: "main" },
    ]);
    for (const repoId of [1001, 1002, 1003]) {
      await bind(t, repoId, "checks", "agt_a");
      await putCheckRun(t, { repo_id: repoId, head_sha: "1".repeat(40), name: "hookci", check_run_id: repoId });
      await insertRun(t, {
        run_id: `run_${repoId}`,
        repo_id: repoId,
        sha: "1".repeat(40),
        ref: "refs/heads/main",
        event: "push",
        pr_number: null,
        env: null,
        attempt: 1,
        trigger_id: `trg_${repoId}`,
        agent_id: "agt_a",
        state: "success",
        reason: null,
        author_login: "alice",
        commit_title: "Ship it",
        started_at: 1,
        finished_at: 2,
        duration_ms: 1,
        log_key: null,
      });
    }
    const watch = { team_id: world.team, notify: "normal", alert: "channel", created_by: "U0ADMIN" } as const;
    await addWatch(t, { ...watch, repo_id: 1001, channel_id: "C1" });
    await addWatch(t, { ...watch, repo_id: 1002, channel_id: "C1" });
    await addWatch(t, { ...watch, repo_id: 1001, channel_id: "C2" });
    await addWatch(t, { ...watch, repo_id: 1003, channel_id: "C3" });
  });

  it("forgets bindings, watches and check runs of the removed repos, keeps runs and posts once per channel", async () => {
    await deliver(removed);

    expect(await rows("SELECT repo_id FROM repos")).toEqual([{ repo_id: 1003 }]);
    expect(await rows("SELECT repo_id FROM repo_bindings")).toEqual([{ repo_id: 1003 }]);
    expect(await rows("SELECT repo_id, channel_id FROM watches")).toEqual([{ repo_id: 1003, channel_id: "C3" }]);
    expect(await rows("SELECT repo_id FROM check_runs")).toEqual([{ repo_id: 1003 }]);
    expect(await rows("SELECT run_id FROM runs ORDER BY run_id")).toEqual([{ run_id: "run_1001" }, { run_id: "run_1002" }, { run_id: "run_1003" }]);

    await vi.waitFor(() => expect(world.slack.calls).toHaveLength(2));
    const posts = world.slack.calls.map((c) => ({ url: c.url, channel: formField(c.body, "channel"), text: formField(c.body, "text") }));
    expect(posts).toEqual([
      { url: "https://slack.com/api/chat.postMessage", channel: "C1", text: S.slack.repoRemoved(["acme/widgets", "acme/gizmos"]) },
      { url: "https://slack.com/api/chat.postMessage", channel: "C2", text: S.slack.repoRemoved(["acme/widgets"]) },
    ]);
    expect(S.slack.repoRemoved(["acme/widgets"])).toBe("acme/widgets was removed from the HookCI GitHub App installation, so this channel no longer watches it.");
  });
});
