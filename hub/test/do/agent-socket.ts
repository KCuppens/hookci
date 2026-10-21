import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { randomToken } from "../../src/crypto";
import { agentCredentialHash, insertAgent } from "../../src/db/agents";
import { tenantDb } from "../../src/db/tenant";
import type { AgentDO } from "../../src/do/agent";
import { PROTOCOL_MAX } from "../../src/do/agent-protocol";

export const AGENT_VERSION = "1.4.0";

export interface Agent {
  agentId: string;
  credential: string;
  stub: DurableObjectStub<AgentDO>;
}

/** Pairs a new agent in D1. Every call gets its own agent id, so its AgentDO starts empty. */
export async function seedAgent(installationId: number): Promise<Agent> {
  const agentId = `agt_${crypto.randomUUID()}`;
  const credential = randomToken("zc_agent_", 32);
  await insertAgent(tenantDb(env.DB, installationId), {
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

export function connectRequest(credential: string | null): Promise<Response> {
  const headers: Record<string, string> = { upgrade: "websocket" };
  if (credential !== null) headers.authorization = `Bearer ${credential}`;
  return exports.default.fetch("https://hub.test/v1/agent/connect", { headers });
}

export interface Closed {
  code: number;
  reason: string;
}

/** The agent's end of the websocket: queues what the hub sends until the test reads it. */
export class AgentSocket {
  readonly closed: Promise<Closed>;
  private readonly queue: string[] = [];
  private readonly waiting: ((text: string) => void)[] = [];
  private seq = 0;

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

  /**
   * Sends frame with the next inbound seq and waits for the hub's ack of it,
   * so its handler has finished; returns the frames the hub sent meanwhile.
   */
  async request(frame: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const seq = ++this.seq;
    this.send({ v: 1, seq, ...frame });
    const sent: Record<string, unknown>[] = [];
    for (;;) {
      const msg = await this.next();
      if (msg.type === "ack" && msg.upto === seq) return sent;
      sent.push(msg);
    }
  }
}

export async function connect(agent: Agent): Promise<AgentSocket> {
  const res = await connectRequest(agent.credential);
  expect(res.status).toBe(101);
  if (!res.webSocket) throw new Error("no websocket in 101 response");
  return new AgentSocket(res.webSocket);
}
