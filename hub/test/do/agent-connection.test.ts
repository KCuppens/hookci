import { listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken } from "../../src/crypto";
import { type AgentRow, agentCredentialHash, insertAgent, revokeAgent } from "../../src/db/agents";
import { markSuspended, upsertInstallation } from "../../src/db/installations";
import { tenantDb } from "../../src/db/tenant";
import { AgentDO } from "../../src/do/agent";
import { registerFrameHandler } from "../../src/do/agent-frames";
import { registerOfflineHook } from "../../src/do/agent-hooks";
import { MAX_FRAME_BYTES, PROTOCOL_MAX, PROTOCOL_MIN } from "../../src/do/agent-protocol";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";

const INSTALLATION = 42;
const AGENT_VERSION = "1.4.0";

interface Agent {
  agentId: string;
  credential: string;
  stub: DurableObjectStub<AgentDO>;
}

// Every test gets its own agent id, so its AgentDO starts empty.
async function seedAgent(): Promise<Agent> {
  const agentId = `agt_${crypto.randomUUID()}`;
  const credential = randomToken("zc_agent_", 32);
  await insertAgent(tenantDb(env.DB, INSTALLATION), {
    agent_id: agentId,
    name: "builder",
    hostname: "builder.local",
    os: "linux",
    arch: "amd64",
    credential_hash: await agentCredentialHash(credential),
    agent_version: AGENT_VERSION,
    paired_by_github_id: 7,
    paired_at: 1,
  });
  return { agentId, credential, stub: env.AGENT_DO.get(env.AGENT_DO.idFromName(agentId)) };
}

function connectRequest(credential: string | null): Promise<Response> {
  const headers: Record<string, string> = { upgrade: "websocket" };
  if (credential !== null) headers.authorization = `Bearer ${credential}`;
  return exports.default.fetch("https://hub.test/v1/agent/connect", { headers });
}

interface Closed {
  code: number;
  reason: string;
}

class AgentSocket {
  readonly closed: Promise<Closed>;
  private readonly queue: string[] = [];
  private readonly waiting: ((text: string) => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const text = typeof e.data === "string" ? e.data : "<binary>";
      const waiter = this.waiting.shift();
      if (waiter) waiter(text);
      else this.queue.push(text);
    });
    // tsconfig's ES2022 lib has no Promise.withResolvers.
    this.closed = new Promise((resolve) => ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason })));
    ws.accept();
  }

  nextText(): Promise<string> {
    const text = this.queue.shift();
    if (text !== undefined) return Promise.resolve(text);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async next(): Promise<Record<string, unknown>> {
    return JSON.parse(await this.nextText());
  }

  send(frame: Record<string, unknown> | string): void {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  async hello(protocol = PROTOCOL_MAX, inboundHwm?: number): Promise<Record<string, unknown>> {
    this.send({ v: 1, type: "hello", protocol_version: protocol, agent_version: AGENT_VERSION, inbound_hwm: inboundHwm });
    return this.next();
  }
}

async function connect(agent: Agent): Promise<AgentSocket> {
  const res = await connectRequest(agent.credential);
  expect(res.status).toBe(101);
  if (!res.webSocket) throw new Error("no websocket in 101 response");
  return new AgentSocket(res.webSocket);
}

function event(seq: number): Record<string, unknown> {
  return { v: 1, type: "event", seq, agent_seq: seq, run_id: "run_1", state: "running" };
}

function agentRow(agentId: string): Promise<AgentRow | null> {
  return env.DB.prepare("SELECT * FROM agents WHERE agent_id = ?1").bind(agentId).first<AgentRow>();
}

async function outboxDepth(agent: Agent): Promise<number> {
  const res = await agent.stub.fetch("https://do/status");
  const status: { outbox_depth: number } = await res.json();
  return status.outbox_depth;
}

const cleanups: (() => void)[] = [];

beforeEach(async () => {
  await clearTables();
  await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", created_at: 1 });
});

afterEach(() => {
  for (const undo of cleanups.splice(0)) undo();
  vi.restoreAllMocks();
});

describe("GET /v1/agent/connect", () => {
  it("rejects missing or unknown credential before upgrade", async () => {
    const before = await listDurableObjectIds(env.AGENT_DO);

    const missing = await connectRequest(null);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "auth_failed" });
    expect(missing.webSocket).toBeNull();

    const unknown = await connectRequest(randomToken("zc_agent_", 32));
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "auth_failed" });

    expect(await listDurableObjectIds(env.AGENT_DO)).toHaveLength(before.length);
  });

  it("rejects revoked agent", async () => {
    const agent = await seedAgent();
    await revokeAgent(tenantDb(env.DB, INSTALLATION), agent.agentId, 5);

    const res = await connectRequest(agent.credential);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "revoked" });
  });

  it("rejects agent of a suspended installation", async () => {
    const agent = await seedAgent();
    await markSuspended(env.DB, INSTALLATION, 5);

    const res = await connectRequest(agent.credential);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "suspended" });
  });

  it("requires a websocket upgrade", async () => {
    const agent = await seedAgent();
    const res = await exports.default.fetch("https://hub.test/v1/agent/connect", {
      headers: { authorization: `Bearer ${agent.credential}` },
    });
    expect(res.status).toBe(426);
  });

  it("limits upgrades per IP with Retry-After", async () => {
    const agent = await seedAgent();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO ip_rate (bucket, count, window_start) VALUES ('agentconn:unknown', 30, ?1)")
      .bind(now - (now % 60_000))
      .run();

    const res = await connectRequest(agent.credential);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});

describe("AgentDO connection", () => {
  it("hello with protocol N and N-1 gets welcome", async () => {
    const agent = await seedAgent();
    for (const protocol of [PROTOCOL_MAX, PROTOCOL_MIN]) {
      const sock = await connect(agent);
      expect(await sock.hello(protocol)).toEqual({
        v: 1,
        type: "welcome",
        hub_version: env.HUB_VERSION,
        protocol_min: PROTOCOL_MIN,
        protocol_max: PROTOCOL_MAX,
        agent_id: agent.agentId,
        installation_id: INSTALLATION,
      });
    }
    const row = await agentRow(agent.agentId);
    expect(row?.status).toBe("online");
    expect(row?.protocol_version).toBe(PROTOCOL_MIN);
  });

  it("hello with unsupported protocol gets protocol_unsupported", async () => {
    const agent = await seedAgent();
    for (const protocol of [PROTOCOL_MAX + 1, PROTOCOL_MIN - 1]) {
      const sock = await connect(agent);
      expect(await sock.hello(protocol)).toMatchObject({
        type: "error",
        code: "protocol_unsupported",
        upgrade_hint: "run: sudo zeroci upgrade",
      });
      expect(await sock.closed).toEqual({ code: 4400, reason: "protocol_unsupported" });
    }
    expect((await agentRow(agent.agentId))?.status).toBe("offline");
  });

  it("first frame not hello is bad_frame", async () => {
    const agent = await seedAgent();
    const handler = vi.fn();
    cleanups.push(registerFrameHandler("event", handler));

    const sock = await connect(agent);
    sock.send(event(1));
    expect(await sock.next()).toMatchObject({ type: "error", code: "bad_frame" });
    expect(await sock.closed).toEqual({ code: 4400, reason: "bad_frame" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("outbox replays unacked frames after reconnect", async () => {
    const agent = await seedAgent();
    const seqs = await runInDurableObject(agent.stub, async (dob) => [
      await dob.send({ v: 1, type: "interrupt", run_id: "run_1", reason: "superseded" }),
      await dob.send({ v: 1, type: "interrupt", run_id: "run_2", reason: "superseded" }),
      await dob.send({ v: 1, type: "interrupt", run_id: "run_3", reason: "superseded" }),
    ]);
    expect(seqs).toEqual([1, 2, 3]);

    // The agent processed seq 1 before it lost the previous connection.
    const sock = await connect(agent);
    expect(await sock.hello(PROTOCOL_MAX, 1)).toMatchObject({ type: "welcome" });
    expect(await sock.next()).toEqual({ v: 1, type: "interrupt", seq: 2, run_id: "run_2", reason: "superseded" });
    expect(await sock.next()).toEqual({ v: 1, type: "interrupt", seq: 3, run_id: "run_3", reason: "superseded" });
    expect(await outboxDepth(agent)).toBe(2);

    sock.send({ v: 1, type: "ack", upto: 3 });
    await vi.waitFor(async () => expect(await outboxDepth(agent)).toBe(0));

    // Frames sent while connected go out at once with the next seq.
    await runInDurableObject(agent.stub, (dob) => dob.send({ v: 1, type: "interrupt", run_id: "run_4", reason: "repair" }));
    expect(await sock.next()).toMatchObject({ type: "interrupt", seq: 4, run_id: "run_4" });
    expect(await outboxDepth(agent)).toBe(1);
  });

  it("duplicate inbound seq is acked but not dispatched", async () => {
    const agent = await seedAgent();
    const handled: unknown[] = [];
    cleanups.push(registerFrameHandler("event", async (_dob, frame) => void handled.push(frame.seq)));

    const sock = await connect(agent);
    await sock.hello();
    sock.send(event(1));
    expect(await sock.next()).toEqual({ v: 1, type: "ack", upto: 1 });
    sock.send(event(1));
    expect(await sock.next()).toEqual({ v: 1, type: "ack", upto: 1 });
    sock.send(event(2));
    expect(await sock.next()).toEqual({ v: 1, type: "ack", upto: 2 });

    // A reconnect keeps the high-water mark.
    const again = await connect(agent);
    await again.hello();
    again.send(event(2));
    expect(await again.next()).toEqual({ v: 1, type: "ack", upto: 2 });

    expect(handled).toEqual([1, 2]);
  });

  it("frame without seq is bad_frame and not dispatched", async () => {
    const agent = await seedAgent();
    const handler = vi.fn();
    cleanups.push(registerFrameHandler("event", handler));

    const sock = await connect(agent);
    await sock.hello();
    sock.send({ v: 1, type: "event", agent_seq: 1, run_id: "run_1", state: "running" });
    expect(await sock.next()).toMatchObject({ type: "error", code: "bad_frame" });
    sock.send({ v: 1, type: "interrupt", seq: 1, reason: "repair" });
    expect(await sock.next()).toMatchObject({ type: "error", code: "bad_frame" });
    sock.send(event(1));
    expect(await sock.next()).toEqual({ v: 1, type: "ack", upto: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("second connection replaces first", async () => {
    const agent = await seedAgent();
    const offline = vi.fn(async () => {});
    cleanups.push(registerOfflineHook(offline));

    const first = await connect(agent);
    await first.hello();
    const second = await connect(agent);
    expect(await first.closed).toEqual({ code: 4000, reason: "replaced" });
    expect(await second.hello()).toMatchObject({ type: "welcome" });

    second.send(event(1));
    expect(await second.next()).toEqual({ v: 1, type: "ack", upto: 1 });
    expect((await agentRow(agent.agentId))?.status).toBe("online");
    expect(offline).not.toHaveBeenCalled();
  });

  it("alarm marks agent offline after 60 s without ping", async () => {
    const agent = await seedAgent();
    const offline = vi.fn(async (dob: AgentDO) => void dob.agentId);
    cleanups.push(registerOfflineHook(offline));

    const sock = await connect(agent);
    await sock.hello();
    expect((await agentRow(agent.agentId))?.status).toBe("online");

    testClock.advance(59_000);
    expect(await runDurableObjectAlarm(agent.stub)).toBe(true);
    expect((await agentRow(agent.agentId))?.status).toBe("online");

    testClock.advance(2_000);
    expect(await runDurableObjectAlarm(agent.stub)).toBe(true);
    expect(await sock.closed).toEqual({ code: 4408, reason: "ping_timeout" });
    const row = await agentRow(agent.agentId);
    expect(row?.status).toBe("offline");
    expect(row?.last_seen_at).toBeLessThan(testClock.now() - 60_000);

    const status: { online: boolean } = await (await agent.stub.fetch("https://do/status")).json();
    expect(status.online).toBe(false);
    expect(offline).toHaveBeenCalledTimes(1);
  });

  it("closing the socket marks agent offline once", async () => {
    const agent = await seedAgent();
    const offline = vi.fn(async () => {});
    cleanups.push(registerOfflineHook(offline));

    const sock = await connect(agent);
    await sock.hello();
    sock.ws.close(1000, "bye");
    await vi.waitFor(async () => expect((await agentRow(agent.agentId))?.status).toBe("offline"));
    expect(offline).toHaveBeenCalledTimes(1);
  });

  it("ping gets pong without waking handler", async () => {
    const agent = await seedAgent();
    const sock = await connect(agent);
    await sock.hello();

    const onMessage = vi.spyOn(AgentDO.prototype, "webSocketMessage");
    sock.send("ping");
    expect(await sock.nextText()).toBe("pong");
    sock.send("ping");
    expect(await sock.nextText()).toBe("pong");
    expect(onMessage).not.toHaveBeenCalled();

    // The runtime stamps auto-answered pings in real time, which the test
    // clock cannot move, so the alarm sees a ping reported 1 s ago.
    testClock.advance(61_000);
    await runInDurableObject(agent.stub, async (dob, state) => {
      vi.spyOn(state, "getWebSocketAutoResponseTimestamp").mockReturnValue(new Date(testClock.now() - 1_000));
      await dob.alarm();
    });
    expect((await agentRow(agent.agentId))?.status).toBe("online");
  });

  it("last_seen_at D1 write is throttled", async () => {
    const agent = await seedAgent();
    const prepare = vi.spyOn(env.DB, "prepare");
    const agentWrites = () => prepare.mock.calls.filter(([sql]) => /^\s*UPDATE agents\b/.test(sql)).length;

    const first = await connect(agent);
    await first.hello();
    expect(agentWrites()).toBe(1);

    for (let seq = 1; seq <= 10; seq++) {
      first.send(event(seq));
      expect(await first.next()).toEqual({ v: 1, type: "ack", upto: seq });
    }
    for (let i = 0; i < 10; i++) {
      const sock = await connect(agent);
      await sock.hello();
    }
    expect(agentWrites()).toBe(1);

    const last = await connect(agent);
    await last.hello();
    testClock.advance(5 * 60_000);
    last.send(event(11));
    expect(await last.next()).toEqual({ v: 1, type: "ack", upto: 11 });
    expect(agentWrites()).toBe(2);
  });

  it("oversized frame is bad_frame", async () => {
    const agent = await seedAgent();
    const sock = await connect(agent);
    await sock.hello();

    const fill = MAX_FRAME_BYTES + 1 - JSON.stringify({ ...event(1), step: "" }).length;
    const oversized = JSON.stringify({ ...event(1), step: "x".repeat(fill) });
    expect(oversized.length).toBe(MAX_FRAME_BYTES + 1);
    sock.send(oversized);
    expect(await sock.next()).toMatchObject({ type: "error", code: "bad_frame", message: expect.stringMatching(/1 MiB/) });

    // Multi-byte text over the limit in UTF-8 but not in UTF-16 units.
    sock.send(JSON.stringify({ ...event(1), step: "é".repeat(MAX_FRAME_BYTES / 2) }));
    expect(await sock.next()).toMatchObject({ type: "error", code: "bad_frame" });

    sock.send(event(1));
    expect(await sock.next()).toEqual({ v: 1, type: "ack", upto: 1 });
  });

  it("too many bad frames close the socket", async () => {
    const agent = await seedAgent();
    const sock = await connect(agent);
    await sock.hello();

    for (let i = 0; i < 21; i++) sock.send("{not json");
    for (let i = 0; i < 21; i++) expect(await sock.next()).toMatchObject({ type: "error", code: "bad_frame" });
    expect(await sock.closed).toEqual({ code: 4400, reason: "bad_frame" });
  });

  it("frame flood is rate_limited", async () => {
    // The test runtime delivers frames slower than 200/s, so all of them
    // arrive at one frozen instant.
    vi.spyOn(testClock, "now").mockReturnValue(testClock.now());
    const agent = await seedAgent();
    const sock = await connect(agent);
    await sock.hello();

    // hello is frame 1 of the second; event 200 is frame 201.
    for (let seq = 1; seq <= 200; seq++) sock.send(event(seq));
    for (let seq = 1; seq <= 199; seq++) expect(await sock.next()).toEqual({ v: 1, type: "ack", upto: seq });
    expect(await sock.next()).toMatchObject({ type: "error", code: "rate_limited" });
    expect(await sock.closed).toEqual({ code: 4429, reason: "rate_limited" });
  });

  it("status reports connection and outbox depth", async () => {
    const agent = await seedAgent();
    await runInDurableObject(agent.stub, (dob) => dob.send({ v: 1, type: "interrupt", run_id: "run_1", reason: "repair" }));
    const sock = await connect(agent);
    await sock.hello(PROTOCOL_MAX, 1);

    const status = await (await agent.stub.fetch("https://do/status")).json();
    expect(status).toEqual({
      online: true,
      last_seen_at: expect.any(Number),
      protocol: PROTOCOL_MAX,
      agent_version: AGENT_VERSION,
      outbox_depth: 0,
    });
  });
});
