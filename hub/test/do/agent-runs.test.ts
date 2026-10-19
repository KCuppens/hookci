import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bind } from "../../src/db/bindings";
import { upsertInstallation } from "../../src/db/installations";
import { tenantDb } from "../../src/db/tenant";
import { registerSinkFactory } from "../../src/sinks";
import type { Sink } from "../../src/sinks/types";
import { S } from "../../src/strings";
import type { TriggerRequest } from "../../src/webhook/route";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { createFakeGitHub } from "../fakes/github";
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
    headers: { "x-zeroci-agent-id": agent.agentId },
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
    await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", created_at: 1 });
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
    expect(sent).toEqual([{ v: 1, type: "error", seq: expect.any(Number), code: "auth_failed", message: S.runNotBound }]);
    expect(sock.ws.readyState).toBe(WebSocket.OPEN);
    expect(gh.calls).toEqual([]);
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
});
