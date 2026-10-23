import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgent, setAgentBudget } from "../../src/db/agents";
import { upsertInstallation } from "../../src/db/installations";
import { tenantDb } from "../../src/db/tenant";
import { PROTOCOL_MAX } from "../../src/do/agent-protocol";
import { clearTables } from "../db/helpers";
import { capacityFrame, GIB } from "../helpers/capacity";
import { AGENT_VERSION, connect, seedAgent } from "./agent-socket";

const ACME = 42;

beforeEach(async () => {
  await clearTables();
  await upsertInstallation(env.DB, { id: ACME, account_login: "acme", account_type: "Organization", account_id: ACME * 10, created_at: 1 });
});

function hello(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, type: "hello", protocol_version: PROTOCOL_MAX, agent_version: AGENT_VERSION, ...extra };
}

describe("capacity frames", () => {
  it("stores the first report in D1 with the host size", async () => {
    const agent = await seedAgent(ACME);
    const sock = await connect(agent);
    sock.send(hello({ host_cpus: 16, host_memory_bytes: 32 * GIB }));
    expect(await sock.next()).toMatchObject({ type: "welcome" });
    expect(await sock.next()).toEqual({ v: 1, type: "budget", cpus: null, memory_bytes: null });
    sock.send({ ...capacityFrame({ backing_off: true }) });
    await vi.waitFor(async () => {
      const row = await getAgent(tenantDb(env.DB, ACME), agent.agentId);
      expect(row?.host_cpus).toBe(16);
      expect(row?.host_memory_bytes).toBe(32 * GIB);
      expect(JSON.parse(row?.last_capacity ?? "null")).toMatchObject({ backing_off: true, granted_cpus: 5, jobs: [{ job: "unit" }] });
      expect(row?.last_capacity_at).not.toBeNull();
    });
    sock.ws.close(1000, "done");
  });

  it("answers an invalid report with an error frame and stores nothing", async () => {
    const agent = await seedAgent(ACME);
    const sock = await connect(agent);
    sock.send(hello({ host_cpus: 16 }));
    await sock.next();
    await sock.next();
    sock.send({ ...capacityFrame({ host_cpus: -3 }) });
    expect(await sock.next()).toMatchObject({ type: "error", code: "bad_frame" });
    expect((await getAgent(tenantDb(env.DB, ACME), agent.agentId))?.last_capacity).toBeNull();
    sock.ws.close(1000, "done");
  });
});

describe("budget frames", () => {
  it("sends the stored override after the welcome of an agent that reported its host size", async () => {
    const agent = await seedAgent(ACME);
    await setAgentBudget(tenantDb(env.DB, ACME), agent.agentId, { cpus: 3, memory_bytes: 6 * GIB });
    const sock = await connect(agent);
    sock.send(hello({ host_cpus: 8, host_memory_bytes: 16 * GIB }));
    expect(await sock.next()).toMatchObject({ type: "welcome" });
    expect(await sock.next()).toEqual({ v: 1, type: "budget", cpus: 3, memory_bytes: 6 * GIB });
    sock.ws.close(1000, "done");
  });

  it("sends nothing to an agent whose hello has no host size", async () => {
    const agent = await seedAgent(ACME);
    await setAgentBudget(tenantDb(env.DB, ACME), agent.agentId, { cpus: 3, memory_bytes: null });
    const sock = await connect(agent);
    sock.send(hello());
    expect(await sock.next()).toMatchObject({ type: "welcome" });
    const sent = await sock.request({ type: "token_request", run_id: "run_none", purpose: "fetch" });
    expect(sent.map((f) => f.type)).toEqual(["error"]);
    sock.ws.close(1000, "done");
  });
});
