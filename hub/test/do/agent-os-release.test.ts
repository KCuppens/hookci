import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getAgent, sanitizeOsRelease } from "../../src/db/agents";
import { upsertInstallation } from "../../src/db/installations";
import { listAgentsWithRuns } from "../../src/db/tabs";
import { tenantDb } from "../../src/db/tenant";
import { PROTOCOL_MAX } from "../../src/do/agent-protocol";
import { QUOTAS } from "../../src/quotas";
import { clearTables } from "../db/helpers";
import { AGENT_VERSION, type Agent, connect, seedAgent } from "./agent-socket";

const ACME = 42;

/** Connects, says hello with extra fields and waits for the welcome. */
async function helloWith(agent: Agent, extra: Record<string, unknown>): Promise<void> {
  const sock = await connect(agent);
  sock.send({ v: 1, type: "hello", protocol_version: PROTOCOL_MAX, agent_version: AGENT_VERSION, ...extra });
  expect(await sock.next()).toMatchObject({ type: "welcome" });
  sock.ws.close(1000, "done");
}

async function osRelease(agent: Agent): Promise<string | null | undefined> {
  return (await getAgent(tenantDb(env.DB, ACME), agent.agentId))?.os_release;
}

describe("sanitizeOsRelease", () => {
  it("passes a plain description through", () => {
    expect(sanitizeOsRelease("Ubuntu 22.04")).toBe("Ubuntu 22.04");
    expect(sanitizeOsRelease("macOS 14.5")).toBe("macOS 14.5");
  });

  it("strips control, format and separator characters and collapses white space", () => {
    expect(sanitizeOsRelease("Ubuntu\u0000 22\u001b[31m.04\r\n")).toBe("Ubuntu 22[31m.04");
    expect(sanitizeOsRelease("  Debian   GNU/Linux \u202e12\u200b ")).toBe("Debian GNU/Linux 12");
    expect(sanitizeOsRelease("a\u2028b\u2029c")).toBe("abc");
  });

  it("cuts to 64 characters without splitting a surrogate pair", () => {
    expect(sanitizeOsRelease("a".repeat(500))).toBe("a".repeat(QUOTAS.osReleaseChars));
    const cut = sanitizeOsRelease("\u{1F600}".repeat(100));
    expect(Array.from(cut ?? "")).toHaveLength(QUOTAS.osReleaseChars);
  });

  it("answers null for anything that is not a printable string", () => {
    for (const value of [undefined, null, 22, {}, ["a"], "", "   ", "\u0000\u0007"]) expect(sanitizeOsRelease(value)).toBeNull();
  });
});

describe("hello os_release", () => {
  beforeEach(async () => {
    await clearTables();
    await upsertInstallation(env.DB, { id: ACME, account_login: "acme", account_type: "Organization", account_id: ACME * 10, created_at: 1 });
  });

  it("stores the agent's os_release and lists it with the agents", async () => {
    const agent = await seedAgent(ACME);
    expect(await osRelease(agent)).toBeNull();
    await helloWith(agent, { os_release: "Ubuntu 22.04" });

    expect(await osRelease(agent)).toBe("Ubuntu 22.04");
    expect(await listAgentsWithRuns(tenantDb(env.DB, ACME))).toEqual([expect.objectContaining({ agent_id: agent.agentId, os_release: "Ubuntu 22.04" })]);
  });

  it("sanitizes what the agent sends", async () => {
    const agent = await seedAgent(ACME);
    await helloWith(agent, { os_release: `\u0000Debian\n${"x".repeat(200)}` });
    expect(await osRelease(agent)).toBe(`Debian${"x".repeat(58)}`);
  });

  it("ignores a value that is not a string and still welcomes the agent", async () => {
    const agent = await seedAgent(ACME);
    await helloWith(agent, { os_release: 42 });
    expect(await osRelease(agent)).toBeNull();
  });

  it("keeps the stored value when a later hello has none, and replaces it when the agent reports a new one", async () => {
    const agent = await seedAgent(ACME);
    await helloWith(agent, { os_release: "Ubuntu 22.04" });
    await helloWith(agent, {});
    expect(await osRelease(agent)).toBe("Ubuntu 22.04");

    await helloWith(agent, { os_release: "Ubuntu 24.04" });
    expect(await osRelease(agent)).toBe("Ubuntu 24.04");
  });

  it("works for an agent that never sends it", async () => {
    const agent = await seedAgent(ACME);
    await helloWith(agent, {});
    expect(await osRelease(agent)).toBeNull();
    expect((await getAgent(tenantDb(env.DB, ACME), agent.agentId))?.status).toBe("online");
  });
});
