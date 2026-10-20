import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bind } from "../../src/db/bindings";
import { upsertInstallation } from "../../src/db/installations";
import { insertRun, updateRunState } from "../../src/db/runs";
import { tenantDb } from "../../src/db/tenant";
import { upsertDeployRender } from "../../src/deploy/render";
import { pruneFinished, TRIGGER_RETENTION_MS } from "../../src/do/agent-runs";
import { QUOTAS } from "../../src/quotas";
import { registerSinkFactory } from "../../src/sinks";
import type { Sink } from "../../src/sinks/types";
import { S } from "../../src/strings";
import type { TriggerRequest } from "../../src/webhook/route";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { createFakeGitHub } from "../fakes/github";
import type { FakeService } from "../fakes/http";
import { generateAppKey } from "../github/helpers";
import { type RecordingSink, recordSink, type SinkCall } from "../sinks/recording";
import { type Agent, type AgentSocket, connect, seedAgent } from "./agent-socket";

const INSTALLATION = 42;
const REPO = 1001;
const SHA_1 = "1".repeat(40);
const SHA_2 = "2".repeat(40);
const SHA_3 = "3".repeat(40);

const PR_TRIGGER: TriggerRequest = {
  installationId: INSTALLATION,
  repoId: REPO,
  repo: "acme/widgets",
  sha: SHA_1,
  ref: "refs/heads/feature",
  event: "pull_request",
  pr: { number: 7, headRef: "feature", headRepoFullName: "acme/widgets", fork: false, authorLogin: "alice" },
  baseSha: "0".repeat(39) + "1",
  authorLogin: "alice",
  commitTitle: "Add widget sizing",
  defaultBranch: "main",
  target: "checks",
  trust: "trusted",
};

const DEPLOY_TRIGGER: TriggerRequest = {
  ...PR_TRIGGER,
  ref: "refs/heads/main",
  event: "push",
  pr: undefined,
  baseSha: undefined,
  target: "deploy:staging",
};

type Row = Record<string, unknown>;

async function postTrigger(agent: Agent, over: Partial<TriggerRequest> = {}): Promise<Response> {
  return agent.stub.fetch("https://do/trigger", {
    method: "POST",
    headers: { "x-hookci-agent-id": agent.agentId },
    body: JSON.stringify({ ...PR_TRIGGER, ...over } satisfies TriggerRequest),
  });
}

async function trigger(agent: Agent, over: Partial<TriggerRequest> = {}): Promise<string> {
  const res = await postTrigger(agent, over);
  expect(res.status).toBe(202);
  const { trigger_id } = await res.json<{ trigger_id: string }>();
  return trigger_id;
}

function runs(): Promise<Row[]> {
  return env.DB.prepare("SELECT * FROM runs ORDER BY rowid")
    .all<Row>()
    .then((r) => r.results);
}

async function run(runId: string): Promise<Row | null> {
  return env.DB.prepare("SELECT * FROM runs WHERE run_id = ?1").bind(runId).first<Row>();
}

function outbox(agent: Agent): Promise<Row[]> {
  return runInDurableObject(agent.stub, (dob) =>
    dob.sql
      .exec<{ frame: string }>("SELECT frame FROM outbox ORDER BY seq")
      .toArray()
      .map((row): Row => JSON.parse(row.frame)),
  );
}

function triggerState(agent: Agent, triggerId: string): Promise<unknown> {
  return runInDurableObject(
    agent.stub,
    (dob) => dob.sql.exec<{ state: string }>("SELECT state FROM triggers WHERE trigger_id = ?", triggerId).one().state,
  );
}

/** Connects, says hello and returns the socket with the welcome read. */
async function online(agent: Agent): Promise<AgentSocket> {
  const sock = await connect(agent);
  expect(await sock.hello()).toMatchObject({ type: "welcome" });
  return sock;
}

/** Triggers PR_TRIGGER (with over) on a connected agent, reads the trigger frame and accepts it as runId. */
async function acceptedRun(agent: Agent, sock: AgentSocket, runId: string, over: Partial<TriggerRequest> = {}): Promise<string> {
  const triggerId = await trigger(agent, over);
  expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id: triggerId });
  expect(await sock.request({ type: "accepted", trigger_id: triggerId, run_id: runId })).toEqual([]);
  return triggerId;
}

function runUpdates(calls: SinkCall[]): Row[] {
  return calls.flatMap((call) => (call.op === "onRunUpdate" ? [{ triggerId: call.run.triggerId, runId: call.run.runId, state: call.run.state, reason: call.run.reason }] : []));
}

/** console.error lines reportError wrote, parsed. */
function reported(spy: { mock: { calls: unknown[][] } }): Row[] {
  return spy.mock.calls.flatMap(([line]) => (typeof line === "string" && line.startsWith("{") ? [JSON.parse(line)] : []));
}

describe("AgentDO run lifecycle", () => {
  const cleanups: (() => void)[] = [];
  let sink: RecordingSink;

  beforeEach(async () => {
    await clearTables();
    await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", account_id: INSTALLATION * 10, created_at: 1 });
    sink = recordSink();
    cleanups.push(sink.undo);
  });

  afterEach(() => {
    for (const undo of cleanups.splice(0)) undo();
    vi.restoreAllMocks();
  });

  it("same idempotency key dispatches once", async () => {
    const agent = await seedAgent(INSTALLATION);
    const triggerId = await trigger(agent);

    const dup = await postTrigger(agent);
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual({ duplicate: true });

    expect(await outbox(agent)).toEqual([expect.objectContaining({ type: "trigger", trigger_id: triggerId })]);
    expect(await runs()).toEqual([expect.objectContaining({ run_id: triggerId, trigger_id: triggerId, attempt: 1, state: "queued" })]);
    expect(runUpdates(sink.calls)).toEqual([{ triggerId, runId: undefined, state: "queued", reason: undefined }]);
  });

  it("retry with attempt 2 dispatches again", async () => {
    const agent = await seedAgent(INSTALLATION);
    const first = await trigger(agent);
    const second = await trigger(agent, { attempt: 2 });
    expect(second).not.toBe(first);

    expect((await outbox(agent)).map((f) => [f.trigger_id, f.attempt])).toContainEqual([second, 2]);
    expect((await runs()).map((r) => [r.trigger_id, r.attempt])).toEqual([
      [first, 1],
      [second, 2],
    ]);
  });

  it("newer PR push supersedes sent trigger", async () => {
    const agent = await seedAgent(INSTALLATION);
    const older = await trigger(agent);
    const newer = await trigger(agent, { sha: SHA_2 });

    expect(await outbox(agent)).toEqual([expect.objectContaining({ type: "trigger", trigger_id: newer, sha: SHA_2 })]);
    expect(await run(older)).toMatchObject({ state: "superseded", finished_at: expect.any(Number) });
    expect(await run(newer)).toMatchObject({ state: "queued" });
    expect(await triggerState(agent, older)).toBe("superseded");
    expect(runUpdates(sink.calls)).toContainEqual({ triggerId: older, runId: undefined, state: "superseded", reason: undefined });
  });

  it("newer PR push interrupts accepted run", async () => {
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    await acceptedRun(agent, sock, "run_a");
    expect(await run("run_a")).toMatchObject({ state: "queued" });

    const newer = await trigger(agent, { sha: SHA_2 });
    const frames = [await sock.next(), await sock.next()];
    expect(frames).toContainEqual(expect.objectContaining({ type: "trigger", trigger_id: newer }));
    expect(frames).toContainEqual({ v: 1, type: "interrupt", seq: expect.any(Number), run_id: "run_a", reason: "superseded" });
    expect(await run("run_a")).toMatchObject({ state: "superseded" });
    expect(runUpdates(sink.calls)).toContainEqual({ triggerId: expect.any(String), runId: "run_a", state: "superseded", reason: undefined });
  });

  it("deploy is never interrupted", async () => {
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    await acceptedRun(agent, sock, "run_deploy", DEPLOY_TRIGGER);
    sock.send({ v: 1, type: "ack", upto: 1 });

    const unaccepted = await trigger(agent, { ...DEPLOY_TRIGGER, sha: SHA_2 });
    expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id: unaccepted });
    const newest = await trigger(agent, { ...DEPLOY_TRIGGER, sha: SHA_3 });
    expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id: newest });

    // Only the newest trigger waits in the outbox: the unaccepted one was replaced, and nothing interrupts run_deploy.
    expect(await outbox(agent)).toEqual([expect.objectContaining({ type: "trigger", trigger_id: newest })]);
    expect(await run("run_deploy")).toMatchObject({ state: "queued", env: "staging" });
    expect(await run(unaccepted)).toMatchObject({ state: "superseded" });
    expect(await triggerState(agent, unaccepted)).toBe("superseded");
  });

  it("a retry of an older commit does not supersede a newer waiting deploy", async () => {
    const agent = await seedAgent(INSTALLATION);
    const a = await trigger(agent, DEPLOY_TRIGGER);
    const b = await trigger(agent, { ...DEPLOY_TRIGGER, sha: SHA_2 });
    expect(await triggerState(agent, a)).toBe("superseded");

    const retry = await trigger(agent, { ...DEPLOY_TRIGGER, attempt: 2 });
    expect((await outbox(agent)).map((f) => f.trigger_id)).toEqual([b, retry]);
    expect(await triggerState(agent, b)).toBe("sent");
    expect(await run(b)).toMatchObject({ state: "queued" });

    // A newer push still replaces the waiting retry.
    const c = await trigger(agent, { ...DEPLOY_TRIGGER, sha: SHA_3 });
    expect((await outbox(agent)).map((f) => f.trigger_id)).toEqual([c]);
    expect(await triggerState(agent, retry)).toBe("superseded");
  });

  it("daily cap", async () => {
    const day = new Date(testClock.now()).toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO daily_counters (installation_id, day, runs) VALUES (?1, ?2, 500)").bind(INSTALLATION, day).run();
    const agent = await seedAgent(INSTALLATION);
    const triggerId = await trigger(agent);

    expect(await run(triggerId)).toMatchObject({ state: "pending", reason: "daily_cap" });
    expect(await outbox(agent)).toEqual([]);
    expect(runUpdates(sink.calls)).toEqual([{ triggerId, runId: undefined, state: "pending", reason: "daily_cap" }]);
    expect(await env.DB.prepare("SELECT runs FROM daily_counters WHERE installation_id = ?1 AND day = ?2").bind(INSTALLATION, day).first("runs")).toBe(501);
  });

  it("a self-hosted hub has no daily cap", async () => {
    const day = new Date(testClock.now()).toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO daily_counters (installation_id, day, runs) VALUES (?1, ?2, 500)").bind(INSTALLATION, day).run();
    const agent = await seedAgent(INSTALLATION);
    const saved = env.HUB_MODE;
    env.HUB_MODE = "self_hosted";
    cleanups.push(() => {
      env.HUB_MODE = saved;
    });
    const triggerId = await trigger(agent);

    expect(await run(triggerId)).toMatchObject({ state: "queued", reason: null });
    expect(await outbox(agent)).toEqual([expect.objectContaining({ type: "trigger", trigger_id: triggerId })]);
    expect(await env.DB.prepare("SELECT runs FROM daily_counters WHERE installation_id = ?1 AND day = ?2").bind(INSTALLATION, day).first("runs")).toBe(501);
  });

  it("job_planned creates queued jobs", async () => {
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    await acceptedRun(agent, sock, "run_a");

    await sock.request({ type: "job_planned", run_id: "run_a", jobs: [{ name: "build", needs: [] }, { name: "test", needs: ["build"] }] });

    const jobs = await env.DB.prepare("SELECT name, state FROM jobs WHERE run_id = 'run_a' ORDER BY rowid").all();
    expect(jobs.results).toEqual([
      { name: "build", state: "queued" },
      { name: "test", state: "queued" },
    ]);
    const planned = sink.calls.filter((call) => call.op === "onJobPlanned");
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      run: {
        runId: "run_a",
        jobs: [
          { name: "build", state: "queued" },
          { name: "test", state: "queued" },
        ],
      },
    });
  });

  it("job_planned keeps the .hookci.yml slack override for the sinks, verbose as normal", async () => {
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    await acceptedRun(agent, sock, "run_a");

    await sock.request({ type: "job_planned", run_id: "run_a", jobs: [{ name: "build", needs: [] }], slack: { channel: "#Deploys", notify: "verbose", alert: "dm" } });
    // The agent's _config job is planned later on its own frame, without the override.
    await sock.request({ type: "job_planned", run_id: "run_a", jobs: [{ name: "_config", needs: [] }] });

    const planned = sink.calls.flatMap((call) => (call.op === "onJobPlanned" ? [call.run.slack] : []));
    expect(planned).toEqual([
      { channel: "deploys", notify: "normal", alert: "dm" },
      { channel: "deploys", notify: "normal", alert: "dm" },
    ]);
  });

  it("event updates run and job state", async () => {
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    const triggerId = await acceptedRun(agent, sock, "run_a");
    await sock.request({ type: "job_planned", run_id: "run_a", jobs: [{ name: "build", needs: [] }] });

    const before = testClock.now();
    await sock.request({ type: "event", agent_seq: 1, run_id: "run_a", state: "running" });
    await sock.request({ type: "event", agent_seq: 2, run_id: "run_a", job: "build", state: "running", step: "compile", step_index: 1, steps_total: 3 });
    expect(await env.DB.prepare("SELECT * FROM jobs WHERE run_id = 'run_a'").first()).toMatchObject({
      state: "running",
      step: "compile",
      step_index: 1,
      steps_total: 3,
    });
    const running = await run("run_a");
    expect(running).toMatchObject({ state: "running", finished_at: null });
    const started = Number(running?.started_at);
    expect(started).toBeGreaterThanOrEqual(before);

    await sock.request({ type: "event", agent_seq: 3, run_id: "run_a", job: "build", state: "success", duration_ms: 1200 });
    testClock.advance(5000);
    await sock.request({ type: "event", agent_seq: 4, run_id: "run_a", state: "success", duration_ms: 5000 });

    expect(await env.DB.prepare("SELECT state, duration_ms FROM jobs WHERE run_id = 'run_a'").first()).toEqual({ state: "success", duration_ms: 1200 });
    const done = await run("run_a");
    expect(done).toMatchObject({ state: "success", started_at: started, duration_ms: 5000 });
    expect(Number(done?.finished_at) - started).toBeGreaterThanOrEqual(5000);
    expect(await triggerState(agent, triggerId)).toBe("done");

    expect(sink.calls).toContainEqual({
      op: "onJobUpdate",
      run: expect.objectContaining({ runId: "run_a" }),
      job: expect.objectContaining({ name: "build", state: "success", durationMs: 1200 }),
    });
    expect(runUpdates(sink.calls).at(-1)).toEqual({ triggerId, runId: "run_a", state: "success", reason: undefined });
  });

  it("token_request for bound repo returns token", async () => {
    const gh = createFakeGitHub();
    gh.respond("POST", "/app/installations/:id/access_tokens", () =>
      Response.json({ token: "ghs_fetch", expires_at: "2030-01-01T00:00:00Z" }, { status: 201 }),
    );
    const saved = { fetcher: env.__TEST_FETCHER, key: env.GITHUB_APP_PRIVATE_KEY };
    env.__TEST_FETCHER = gh.fetcher;
    env.GITHUB_APP_PRIVATE_KEY = (await generateAppKey()).pem;
    cleanups.push(() => {
      env.__TEST_FETCHER = saved.fetcher;
      env.GITHUB_APP_PRIVATE_KEY = saved.key;
    });

    const agent = await seedAgent(INSTALLATION);
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "checks", agent.agentId);
    const sock = await online(agent);
    await acceptedRun(agent, sock, "run_a");

    const sent = await sock.request({ type: "token_request", run_id: "run_a", purpose: "fetch" });
    expect(sent).toEqual([
      { v: 1, type: "token", seq: expect.any(Number), run_id: "run_a", token: "ghs_fetch", exp: Math.floor(Date.parse("2030-01-01T00:00:00Z") / 1000) },
    ]);
    expect(gh.calls).toEqual([
      {
        method: "POST",
        url: `https://api.github.com/app/installations/${INSTALLATION}/access_tokens`,
        body: { repository_ids: [REPO], permissions: { contents: "read" } },
      },
    ]);
  });

  it("token_request for unbound repo is refused", async () => {
    const gh = createFakeGitHub();
    const saved = env.__TEST_FETCHER;
    env.__TEST_FETCHER = gh.fetcher;
    cleanups.push(() => {
      env.__TEST_FETCHER = saved;
    });

    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    await acceptedRun(agent, sock, "run_a");

    const sent = await sock.request({ type: "token_request", run_id: "run_a", purpose: "fetch" });
    expect(sent).toEqual([{ v: 1, type: "error", seq: expect.any(Number), code: "auth_failed", run_id: "run_a", message: S.runNotBound }]);
    expect(sock.ws.readyState).toBe(WebSocket.OPEN);
    expect(gh.calls).toEqual([]);
  });

  /** Serves installation token mints from a fake GitHub for this test. */
  async function fakeTokenMint(): Promise<FakeService> {
    const gh = createFakeGitHub();
    gh.respond("POST", "/app/installations/:id/access_tokens", () =>
      Response.json({ token: "ghs_fetch", expires_at: "2030-01-01T00:00:00Z" }, { status: 201 }),
    );
    const saved = { fetcher: env.__TEST_FETCHER, key: env.GITHUB_APP_PRIVATE_KEY };
    env.__TEST_FETCHER = gh.fetcher;
    env.GITHUB_APP_PRIVATE_KEY = (await generateAppKey()).pem;
    cleanups.push(() => {
      env.__TEST_FETCHER = saved.fetcher;
      env.GITHUB_APP_PRIVATE_KEY = saved.key;
    });
    return gh;
  }

  /** tenant_denied events logged through the console.log spy. */
  function denials(spy: { mock: { calls: unknown[][] } }): Row[] {
    return spy.mock.calls.flatMap(([line]) => {
      if (typeof line !== "string" || !line.startsWith("{")) return [];
      const entry = JSON.parse(line) as Row;
      return entry.event === "tenant_denied" ? [entry] : [];
    });
  }

  it("token_request by trigger id serves a sent deploy trigger until it is answered", async () => {
    const gh = await fakeTokenMint();
    const agent = await seedAgent(INSTALLATION);
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "deploy:staging", agent.agentId);
    const sock = await online(agent);
    const triggerId = await trigger(agent, DEPLOY_TRIGGER);
    expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id: triggerId, env: "staging" });

    // The agent checks GitHub before it answers, so it has no run id yet.
    const sent = await sock.request({ type: "token_request", run_id: triggerId, purpose: "fetch" });
    expect(sent).toEqual([
      { v: 1, type: "token", seq: expect.any(Number), run_id: triggerId, token: "ghs_fetch", exp: Math.floor(Date.parse("2030-01-01T00:00:00Z") / 1000) },
    ]);
    expect(gh.calls).toEqual([
      {
        method: "POST",
        url: `https://api.github.com/app/installations/${INSTALLATION}/access_tokens`,
        body: { repository_ids: [REPO], permissions: { contents: "read" } },
      },
    ]);

    // Once answered the trigger is finished: the same request gets today's refusal.
    expect(await sock.request({ type: "rejected", trigger_id: triggerId, reason: "deployments.staging: untrusted trigger cannot deploy" })).toEqual([]);
    expect(await triggerState(agent, triggerId)).toBe("rejected");
    const log = vi.spyOn(console, "log");
    expect(await sock.request({ type: "token_request", run_id: triggerId, purpose: "fetch" })).toEqual([
      { v: 1, type: "error", seq: expect.any(Number), code: "auth_failed", run_id: triggerId, message: S.runNotBound },
    ]);
    expect(denials(log)).toEqual([expect.objectContaining({ agent_id: agent.agentId, run_id: triggerId, reason: "run_not_bound" })]);
    expect(gh.calls).toHaveLength(1);
  });

  it("token_request by trigger id serves a deploy trigger superseded before its ack until it is answered", async () => {
    const gh = await fakeTokenMint();
    const agent = await seedAgent(INSTALLATION);
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "deploy:staging", agent.agentId);
    const sock = await online(agent);
    const older = await trigger(agent, DEPLOY_TRIGGER);
    expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id: older });

    // A newer deploy replaces it before the agent's ack lands, while the agent may already be checking it.
    const newer = await trigger(agent, { ...DEPLOY_TRIGGER, sha: SHA_2 });
    expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id: newer });
    expect(await triggerState(agent, older)).toBe("superseded");
    const tokenRequest = { type: "token_request", run_id: older, purpose: "fetch" };
    expect(await sock.request(tokenRequest)).toEqual([
      { v: 1, type: "token", seq: expect.any(Number), run_id: older, token: "ghs_fetch", exp: Math.floor(Date.parse("2030-01-01T00:00:00Z") / 1000) },
    ]);

    // Still only for the bound agent.
    const refused = { v: 1, type: "error", seq: expect.any(Number), code: "auth_failed", run_id: older, message: S.runNotBound };
    const log = vi.spyOn(console, "log");
    const other = await seedAgent(INSTALLATION);
    const otherSock = await online(other);
    expect(await otherSock.request(tokenRequest)).toEqual([refused]);
    otherSock.ws.close();

    // Once accepted it has a run id, which the agent asks by; the trigger id is refused.
    expect(await sock.request({ type: "accepted", trigger_id: older, run_id: "run_old" })).toEqual([
      { v: 1, type: "interrupt", seq: expect.any(Number), run_id: "run_old", reason: "superseded" },
    ]);
    expect(await sock.request(tokenRequest)).toEqual([refused]);
    expect(await sock.request({ ...tokenRequest, run_id: "run_old" })).toEqual([expect.objectContaining({ type: "token", run_id: "run_old" })]);

    expect(denials(log)).toEqual([
      expect.objectContaining({ agent_id: other.agentId, run_id: older, reason: "run_not_bound" }),
      expect.objectContaining({ agent_id: agent.agentId, run_id: older, reason: "run_not_bound" }),
    ]);
    expect(gh.calls).toHaveLength(2);
  });

  it("token_request by trigger id is refused to other agents and for unknown or checks triggers", async () => {
    const gh = await fakeTokenMint();
    const owner = await seedAgent(INSTALLATION);
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "deploy:staging", owner.agentId);
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "checks", owner.agentId);
    const ownerSock = await online(owner);
    const deployId = await trigger(owner, DEPLOY_TRIGGER);
    expect(await ownerSock.next()).toMatchObject({ type: "trigger", trigger_id: deployId });
    const checksId = await trigger(owner);
    expect(await ownerSock.next()).toMatchObject({ type: "trigger", trigger_id: checksId });

    const OTHER_INSTALLATION = INSTALLATION + 1;
    await upsertInstallation(env.DB, { id: OTHER_INSTALLATION, account_login: "evil", account_type: "Organization", account_id: OTHER_INSTALLATION * 10, created_at: 1 });
    const sameTenant = await seedAgent(INSTALLATION);
    const otherTenant = await seedAgent(OTHER_INSTALLATION);
    const refused = (runId: string) => ({ v: 1, type: "error", seq: expect.any(Number), code: "auth_failed", run_id: runId, message: S.runNotBound });

    const log = vi.spyOn(console, "log");
    for (const agent of [sameTenant, otherTenant]) {
      const sock = await online(agent);
      expect(await sock.request({ type: "token_request", run_id: deployId, purpose: "fetch" })).toEqual([refused(deployId)]);
      expect(sock.ws.readyState).toBe(WebSocket.OPEN);
      sock.ws.close();
    }
    for (const runId of ["trg_unknown", checksId]) {
      expect(await ownerSock.request({ type: "token_request", run_id: runId, purpose: "fetch" })).toEqual([refused(runId)]);
    }

    expect(denials(log)).toEqual([
      expect.objectContaining({ installation_id: INSTALLATION, agent_id: sameTenant.agentId, run_id: deployId, reason: "run_not_bound" }),
      expect.objectContaining({ installation_id: OTHER_INSTALLATION, agent_id: otherTenant.agentId, run_id: deployId, reason: "run_not_bound" }),
      expect.objectContaining({ agent_id: owner.agentId, run_id: "trg_unknown", reason: "run_not_bound" }),
      expect.objectContaining({ agent_id: owner.agentId, run_id: checksId, reason: "run_not_bound" }),
    ]);
    expect(gh.calls).toEqual([]);
    expect(await triggerState(owner, deployId)).toBe("sent");
  });

  it("offline 10 minutes marks pending runs agent_offline", async () => {
    const agent = await seedAgent(INSTALLATION);
    const triggerId = await trigger(agent);

    testClock.advance(5 * 60_000);
    expect(await runDurableObjectAlarm(agent.stub)).toBe(true);
    expect(await run(triggerId)).toMatchObject({ state: "queued", reason: null });

    testClock.advance(5 * 60_000);
    expect(await runDurableObjectAlarm(agent.stub)).toBe(true);
    expect(await run(triggerId)).toMatchObject({ state: "pending", reason: "agent_offline" });
    expect(runUpdates(sink.calls).at(-1)).toEqual({ triggerId, runId: undefined, state: "pending", reason: "agent_offline" });

    // The outbox replays the trigger on reconnect; accepting it queues the run again.
    const sock = await connect(agent);
    expect(await sock.hello()).toMatchObject({ type: "welcome" });
    expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id: triggerId });
    await sock.request({ type: "accepted", trigger_id: triggerId, run_id: "run_a" });
    expect(await run("run_a")).toMatchObject({ state: "queued", reason: null });
  });

  it("going offline tells sinks once with the affected runs", async () => {
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    await acceptedRun(agent, sock, "run_a");

    sock.ws.close(1000, "bye");
    await vi.waitFor(() => expect(sink.calls.filter((call) => call.op === "onAgentOffline")).toHaveLength(1));
    expect(sink.calls.find((call) => call.op === "onAgentOffline")).toMatchObject({
      agent: { agentId: agent.agentId, installationId: INSTALLATION, name: "builder" },
      affected: [{ runId: "run_a", state: "queued" }],
    });
  });

  it("rejected marks run skipped with the reason", async () => {
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    const triggerId = await trigger(agent);
    await sock.next();

    const before = testClock.now();
    await sock.request({ type: "rejected", trigger_id: triggerId, reason: "no_config" });

    const row = await run(triggerId);
    expect(row).toMatchObject({ state: "skipped", reason: "no_config" });
    expect(Number(row?.finished_at)).toBeGreaterThanOrEqual(before);
    expect(await triggerState(agent, triggerId)).toBe("rejected");
    expect(runUpdates(sink.calls).at(-1)).toEqual({ triggerId, runId: undefined, state: "skipped", reason: "no_config" });
  });

  it("annotations reach sinks with line ranges", async () => {
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    await acceptedRun(agent, sock, "run_a");

    await sock.request({
      type: "annotations",
      agent_seq: 1,
      run_id: "run_a",
      job: "lint",
      items: [{ path: "src/a.ts", line: 3, level: "warning", message: "unused" }],
    });

    expect(sink.calls).toContainEqual({
      op: "onAnnotations",
      run: expect.objectContaining({ runId: "run_a" }),
      job: "lint",
      annotations: [{ path: "src/a.ts", start_line: 3, end_line: 3, level: "warning", message: "unused", title: undefined }],
    });
  });

  it("interrupt route sends interrupt", async () => {
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);

    const res = await agent.stub.fetch("https://do/interrupt", { method: "POST", body: JSON.stringify({ run_id: "run_a", reason: "cancelled" }) });
    expect(res.status).toBe(202);
    expect(await sock.next()).toEqual({ v: 1, type: "interrupt", seq: 1, run_id: "run_a", reason: "cancelled" });
  });

  it("sink failure does not break lifecycle", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fail = (): never => {
      throw new Error("sink down");
    };
    const broken: Sink = {
      name: "broken",
      onRunUpdate: fail,
      onJobPlanned: fail,
      onJobUpdate: fail,
      onAnnotations: fail,
      onAgentOffline: fail,
    };
    cleanups.push(registerSinkFactory("broken", () => broken));

    const agent = await seedAgent(INSTALLATION);
    const older = await trigger(agent);
    const newer = await trigger(agent, { sha: SHA_2 });

    expect(await run(older)).toMatchObject({ state: "superseded" });
    expect(await run(newer)).toMatchObject({ state: "queued" });
    expect(runUpdates(sink.calls)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ triggerId: older, state: "superseded" }),
        expect.objectContaining({ triggerId: newer, state: "queued" }),
      ]),
    );
    await vi.waitFor(() =>
      expect(reported(errors)).toContainEqual(expect.objectContaining({ sink: "broken", level: "error", error: expect.objectContaining({ message: "sink down" }) })),
    );
  });

  it("a frame whose handler fails is not acked and closes the socket, so the replay is handled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    const triggerId = await trigger(agent);
    await sock.next();

    await env.DB.prepare("CREATE TRIGGER fail_run_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'd1 down'); END").run();
    try {
      sock.send({ v: 1, seq: 1, type: "accepted", trigger_id: triggerId, run_id: "run_a" });
      expect(await sock.closed).toMatchObject({ code: 1011 });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_run_update").run();
    }

    const again = await online(agent);
    expect(await again.next()).toMatchObject({ type: "trigger", trigger_id: triggerId });
    await again.request({ type: "accepted", trigger_id: triggerId, run_id: "run_a" });
    expect(await run("run_a")).toMatchObject({ trigger_id: triggerId, state: "queued" });
  });

  it("a replayed accepted frame with a new seq leaves the run as it was", async () => {
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    const triggerId = await acceptedRun(agent, sock, "run_a");

    await sock.request({ type: "accepted", trigger_id: triggerId, run_id: "run_a" });
    expect(await runs()).toEqual([expect.objectContaining({ run_id: "run_a", trigger_id: triggerId, state: "queued" })]);
  });

  it("a late state update does not overwrite a superseded run", async () => {
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    await acceptedRun(agent, sock, "run_a");
    await trigger(agent, { sha: SHA_2 });
    expect(await run("run_a")).toMatchObject({ state: "superseded" });

    expect(await updateRunState(tenantDb(env.DB, INSTALLATION), "run_a", "success")).toBe(false);
    expect(await run("run_a")).toMatchObject({ state: "superseded" });
  });

  it("gives the daily run back when recording the run fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const day = new Date(testClock.now()).toISOString().slice(0, 10);
    const agent = await seedAgent(INSTALLATION);
    await env.DB.prepare("CREATE TRIGGER fail_run_insert BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'd1 down'); END").run();
    try {
      await expect(postTrigger(agent)).rejects.toThrow("d1 down");
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_run_insert").run();
    }
    expect(await env.DB.prepare("SELECT runs FROM daily_counters WHERE installation_id = ?1 AND day = ?2").bind(INSTALLATION, day).first("runs")).toBe(0);
  });

  it("prunes finished triggers and stored tails past retention", async () => {
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    const rejected = await trigger(agent);
    await sock.next();
    await sock.request({ type: "rejected", trigger_id: rejected, reason: "no_config" });
    const open = await trigger(agent, { sha: SHA_2 });
    await runInDurableObject(agent.stub, (dob) => dob.state.storage.put("slack:tail:old", { at: testClock.now() }));

    await runInDurableObject(agent.stub, (dob) => pruneFinished(dob, testClock.now() + TRIGGER_RETENTION_MS + 1));

    const left = await runInDurableObject(agent.stub, async (dob) => ({
      triggers: dob.sql.exec<{ trigger_id: string }>("SELECT trigger_id FROM triggers").toArray().map((r) => r.trigger_id),
      tails: [...(await dob.state.storage.list({ prefix: "slack:tail:" })).keys()],
    }));
    expect(left).toEqual({ triggers: [open], tails: [] });
  });

  it("revoke drops the outbox, triggers and stored tails", async () => {
    const agent = await seedAgent(INSTALLATION);
    await trigger(agent);
    await runInDurableObject(agent.stub, (dob) => dob.state.storage.put("slack:tail:r", { at: testClock.now() }));

    const res = await agent.stub.fetch("https://do/revoke", { method: "POST", body: JSON.stringify({ reason: "revoked" }) });
    expect(res.ok).toBe(true);

    const left = await runInDurableObject(agent.stub, async (dob) => ({
      outbox: dob.sql.exec("SELECT 1 FROM outbox").toArray().length,
      triggers: dob.sql.exec("SELECT 1 FROM triggers").toArray().length,
      tails: (await dob.state.storage.list({ prefix: "slack:tail:" })).size,
    }));
    expect(left).toEqual({ outbox: 0, triggers: 0, tails: 0 });
  });

  it("an accepted frame naming another agent's run is acked and leaves that run as it was", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = await seedAgent(INSTALLATION);
    const ownerSock = await online(owner);
    const ownerTrigger = await acceptedRun(owner, ownerSock, "run_a");
    const before = await run("run_a");

    const intruder = await seedAgent(INSTALLATION);
    const sock = await online(intruder);
    const triggerId = await trigger(intruder, { repoId: 1002, repo: "acme/gadgets", sha: SHA_2 });
    expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id: triggerId });
    expect(await sock.request({ type: "accepted", trigger_id: triggerId, run_id: "run_a" })).toEqual([]);
    expect(await sock.request({ type: "accepted", trigger_id: triggerId, run_id: 7 })).toEqual([]);

    expect(await run("run_a")).toEqual(before);
    expect(before).toMatchObject({ trigger_id: ownerTrigger, agent_id: owner.agentId, state: "queued" });
    // The intruder still owns nothing it can report on, and its socket stays open for its own run.
    await sock.request({ type: "event", agent_seq: 1, run_id: "run_a", state: "success", duration_ms: 1 });
    expect(await run("run_a")).toEqual(before);
    expect(await sock.request({ type: "accepted", trigger_id: triggerId, run_id: "run_b" })).toEqual([]);
    expect(await run("run_b")).toMatchObject({ trigger_id: triggerId, agent_id: intruder.agentId, repo_id: 1002 });
  });

  it("an accepted deploy naming another installation's run leaves that installation's deploy rows as they were", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const OTHER = 43;
    const other = tenantDb(env.DB, OTHER);
    await upsertInstallation(env.DB, { id: OTHER, account_login: "other", account_type: "Organization", account_id: OTHER * 10, created_at: 1 });
    await insertRun(other, {
      run_id: "run_other",
      repo_id: 9001,
      sha: SHA_3,
      ref: "refs/heads/main",
      event: "push",
      pr_number: null,
      env: "staging",
      attempt: 1,
      trigger_id: "trg_other",
      agent_id: "agt_other",
      state: "success",
      reason: null,
      author_login: null,
      commit_title: null,
      started_at: 1,
      finished_at: 2,
      duration_ms: 1,
      log_key: null,
    });
    await env.DB.prepare(
      `INSERT INTO deploy_triggers (installation_id, repo, sha, env, attempt, event, ref, trigger_id, agent_id, run_id, status, created_at, updated_at)
      VALUES (?1, 'other/app', ?2, 'staging', 1, 'push', 'refs/heads/main', 'trg_other', 'agt_other', 'run_other', 'accepted', 1, 1)`,
    )
      .bind(OTHER, SHA_3)
      .run();
    await upsertDeployRender(other, {
      run_id: "run_other",
      repo: "other/app",
      env: "staging",
      sha: SHA_3,
      slack_channel: "C0OTHER",
      slack_ts: "1.1",
      check_run_id: 77,
      state: "succeeded",
      step: null,
      step_index: null,
      steps_total: null,
      started_at: 1,
      updated_at: 2,
    });
    const deployRows = async () => [
      (await env.DB.prepare("SELECT * FROM deploy_renders WHERE installation_id = ?1").bind(OTHER).all()).results,
      (await env.DB.prepare("SELECT * FROM deploy_triggers WHERE installation_id = ?1").bind(OTHER).all()).results,
      await run("run_other"),
    ];
    const before = await deployRows();

    const agent = await seedAgent(INSTALLATION);
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "deploy:staging", agent.agentId);
    const sock = await online(agent);
    const triggerId = await trigger(agent, DEPLOY_TRIGGER);
    expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id: triggerId });
    expect(await sock.request({ type: "accepted", trigger_id: triggerId, run_id: "run_other" })).toEqual([]);
    await sock.request({ type: "event", agent_seq: 1, run_id: "run_other", state: "failed", duration_ms: 1 });

    expect(await deployRows()).toEqual(before);
    expect(await sock.request({ type: "accepted", trigger_id: triggerId, run_id: "run_mine" })).toEqual([]);
    expect(await run("run_mine")).toMatchObject({ installation_id: INSTALLATION, trigger_id: triggerId });
  });

  it("caps the jobs of a run at QUOTAS.jobsPerRun", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const agent = await seedAgent(INSTALLATION);
    const sock = await online(agent);
    await acceptedRun(agent, sock, "run_a");
    const jobs = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, needs: [] }));
    const count = async () => (await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE run_id = 'run_a'").first<number>("n")) ?? 0;

    expect(await sock.request({ type: "job_planned", run_id: "run_a", jobs: jobs(QUOTAS.jobsPerRun + 1, "j") })).toEqual([]);
    expect(await count()).toBe(0);

    await sock.request({ type: "job_planned", run_id: "run_a", jobs: jobs(QUOTAS.jobsPerRun - 1, "j") });
    expect(await sock.request({ type: "job_planned", run_id: "run_a", jobs: jobs(2, "extra") })).toEqual([]);
    expect(await count()).toBe(QUOTAS.jobsPerRun - 1);

    await sock.request({ type: "event", agent_seq: 1, run_id: "run_a", job: "last", state: "running" });
    expect(await count()).toBe(QUOTAS.jobsPerRun);
    await sock.request({ type: "event", agent_seq: 2, run_id: "run_a", job: "over", state: "running" });
    expect(await count()).toBe(QUOTAS.jobsPerRun);
    expect(await env.DB.prepare("SELECT 1 FROM jobs WHERE run_id = 'run_a' AND name = 'over'").first()).toBeNull();
  });
});
