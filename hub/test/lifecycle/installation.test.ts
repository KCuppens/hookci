import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex, hmacSha256 } from "../../src/crypto";
import { bind } from "../../src/db/bindings";
import { upsertInstallation } from "../../src/db/installations";
import { upsertRepos } from "../../src/db/repos";
import { tenantDb } from "../../src/db/tenant";
import { CLOSE } from "../../src/do/agent-protocol";
import { GitHubClient } from "../../src/github/client";
import worker from "../../src/index";
import type { TriggerRequest } from "../../src/webhook/route";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { type Agent, type AgentSocket, connect, seedAgent } from "../do/agent-socket";
import { createFakeGitHub, serveInstallationTokens } from "../fakes/github";
import type { FakeService } from "../fakes/http";
import { generateAppKey } from "../github/helpers";
import deleted from "../fixtures/github/installation.deleted.json";
import suspend from "../fixtures/github/installation.suspend.json";
import unsuspend from "../fixtures/github/installation.unsuspend.json";
import pushMain from "../fixtures/github/push.main.json";

const INSTALLATION = 42;
const REPO = 1001;

type Row = Record<string, unknown>;

async function deliver(event: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const headers = new Headers({
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": crypto.randomUUID(),
    "x-hub-signature-256": `sha256=${hex(await hmacSha256(env.GITHUB_WEBHOOK_SECRET, body))}`,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://hub.test/github/webhook", { method: "POST", headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(202);
}

async function rows(sql: string): Promise<Row[]> {
  return (await env.DB.prepare(sql).all<Row>()).results;
}

/** Triggers a PR run on agent, reads the trigger frame on sock and accepts it as runId. */
async function acceptedRun(agent: Agent, sock: AgentSocket, runId: string): Promise<void> {
  const trigger: TriggerRequest = {
    installationId: INSTALLATION,
    repoId: REPO,
    repo: "acme/widgets",
    sha: "1".repeat(40),
    ref: "refs/heads/feature",
    event: "pull_request",
    pr: { number: 7, headRef: "feature", headRepoFullName: "acme/widgets", fork: false, authorLogin: "alice" },
    authorLogin: "alice",
    commitTitle: "Add widget sizing",
    defaultBranch: "main",
    target: "checks",
    trust: "trusted",
  };
  const res = await agent.stub.fetch("https://do/trigger", { method: "POST", headers: { "x-zeroci-agent-id": agent.agentId }, body: JSON.stringify(trigger) });
  const { trigger_id } = await res.json<{ trigger_id: string }>();
  expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id });
  expect(await sock.request({ type: "accepted", trigger_id, run_id: runId })).toEqual([]);
}

function mints(gh: FakeService): number {
  return gh.calls.filter((c) => c.method === "POST" && c.url.endsWith(`/app/installations/${INSTALLATION}/access_tokens`)).length;
}

function checkRunCalls(gh: FakeService): number {
  return gh.calls.filter((c) => c.url.includes("/check-runs")).length;
}

let gh: FakeService;
const restore: (() => void)[] = [];

beforeEach(async () => {
  await clearTables();
  await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", account_id: INSTALLATION * 10, created_at: 1 });
  gh = createFakeGitHub();
  serveInstallationTokens(gh, testClock.now());
  let checkRunId = 1;
  gh.respond("POST", "/repos/:owner/:repo/check-runs", () => Response.json({ id: checkRunId++ }, { status: 201 }));
  gh.respond("PATCH", "/repos/:owner/:repo/check-runs/:id", ({ params }) => Response.json({ id: Number(params.id) }));
  const saved = { fetcher: env.__TEST_FETCHER, key: env.GITHUB_APP_PRIVATE_KEY };
  env.__TEST_FETCHER = gh.fetcher;
  env.GITHUB_APP_PRIVATE_KEY = (await generateAppKey()).pem;
  restore.push(() => {
    env.__TEST_FETCHER = saved.fetcher;
    env.GITHUB_APP_PRIVATE_KEY = saved.key;
  });
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  vi.restoreAllMocks();
});

describe("installation deleted", () => {
  it("schedules the purge in 24 h, interrupts and revokes every agent, cancels pending runs and re-mints tokens", async () => {
    const online = await seedAgent(INSTALLATION);
    const offline = await seedAgent(INSTALLATION);
    const sock = await connect(online);
    expect(await sock.hello()).toMatchObject({ type: "welcome" });
    await acceptedRun(online, sock, "run_a");
    // REPO is unbound, so the push leaves a pending no_agent run.
    await deliver("push", pushMain);
    expect(await rows("SELECT state, reason FROM runs WHERE state = 'pending'")).toEqual([{ state: "pending", reason: "no_agent" }]);

    const github = new GitHubClient(env, gh.fetcher, () => testClock.now());
    await github.installation(INSTALLATION);
    await github.installation(INSTALLATION);
    expect(mints(gh)).toBe(1);

    const before = testClock.now();
    await deliver("installation", deleted);
    const after = testClock.now();

    const [inst] = await rows("SELECT deleted_at, purge_after FROM installations");
    expect(inst!.deleted_at).toBeGreaterThanOrEqual(before);
    expect(inst!.deleted_at).toBeLessThanOrEqual(after);
    expect(inst!.purge_after).toBe(Number(inst!.deleted_at) + 86_400_000);

    expect(await sock.next()).toEqual({ v: 1, type: "interrupt", seq: expect.any(Number), run_id: "run_a", reason: "uninstalled" });
    expect((await sock.closed).code).toBe(CLOSE.revoked);
    expect(await rows("SELECT agent_id, status FROM agents ORDER BY agent_id")).toEqual(
      [online.agentId, offline.agentId].sort().map((agent_id) => ({ agent_id, status: "revoked" })),
    );
    expect(await rows("SELECT state, reason, finished_at IS NOT NULL AS finished FROM runs WHERE reason = 'no_agent'")).toEqual([
      { state: "cancelled", reason: "no_agent", finished: 1 },
    ]);
    // The accepted run_a was queued; uninstall leaves no run open, whatever state it was in.
    expect(await rows("SELECT state FROM runs WHERE state IN ('received', 'queued', 'pending', 'running')")).toEqual([]);

    await github.installation(INSTALLATION);
    expect(mints(gh)).toBe(2);
  });
});

describe("installation suspend and unsuspend", () => {
  it("parks pushes as pending suspended runs without check runs until unsuspend", async () => {
    const agent = await seedAgent(INSTALLATION);
    const t = tenantDb(env.DB, INSTALLATION);
    await upsertRepos(t, [{ repo_id: REPO, full_name: "acme/widgets", default_branch: "main" }]);
    await bind(t, REPO, "checks", agent.agentId);
    await deliver("installation", suspend);
    expect((await rows("SELECT suspended_at FROM installations"))[0]!.suspended_at).toEqual(expect.any(Number));
    await deliver("push", pushMain);
    expect(await rows("SELECT agent_id, state, reason FROM runs")).toEqual([{ agent_id: null, state: "pending", reason: "suspended" }]);
    expect(checkRunCalls(gh)).toBe(0);

    await deliver("installation", unsuspend);
    expect(await rows("SELECT suspended_at FROM installations")).toEqual([{ suspended_at: null }]);
    await deliver("push", { ...pushMain, after: "2".repeat(40), head_commit: { ...pushMain.head_commit, id: "2".repeat(40) } });
    expect(await rows("SELECT agent_id, state FROM runs WHERE reason IS NULL")).toEqual([{ agent_id: agent.agentId, state: "queued" }]);
    await vi.waitFor(() => expect(checkRunCalls(gh)).toBeGreaterThan(0));
  });
});
