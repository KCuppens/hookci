import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { csrfForForm } from "../src/accounts/csrf";
import { bind } from "../src/db/bindings";
import { tenantDb } from "../src/db/tenant";
import { issueSession } from "../src/oauth/state";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { seedTenant, type Tenant } from "./helpers/tenants";
import { sanitizeCapacity } from "../src/capacity";
import { PROTOCOL_MAX } from "../src/do/agent-protocol";
import { AGENT_VERSION, connect } from "./do/agent-socket";
import { capacityFrame } from "./helpers/capacity";

const ORIGIN = "https://hub.test";
const ACME = 42;
const UMBRELLA = 43;
const OWNER = 7001;
const P = S.agents.pairing;
const D = S.agents.detail;

let acme: Tenant;
let umbrella: Tenant;

beforeEach(async () => {
  await clearTables();
  acme = await seedTenant(env, { installationId: ACME, teamId: "T0ACME" });
  umbrella = await seedTenant(env, { installationId: UMBRELLA, teamId: "T0UMBRELLA" });
  // A personal account: its owner, matched by GitHub user id, is its administrator.
  await env.DB.prepare("UPDATE installations SET account_type = 'User', account_id = ?1 WHERE id IN (?2, ?3)").bind(OWNER, ACME, UMBRELLA).run();
});

afterEach(() => vi.restoreAllMocks());

async function sessionFor(installationIds: number[], githubUserId = OWNER): Promise<string> {
  const setCookie = await issueSession(env, { installationIds, githubUserId, githubLogin: "octocat" }, testClock.now());
  return setCookie.split(";")[0] ?? "";
}

async function get(path: string, ids = [ACME]): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}${path}`, { headers: { cookie: await sessionFor(ids) }, redirect: "manual" });
}

interface PostOptions {
  installationId?: number;
  session?: string;
  origin?: string | null;
  csrf?: "valid" | "wrong" | "none";
  fields?: Record<string, string>;
}

/** POSTs a form as a browser would: session and csrf cookies, a csrf field, the hub's Origin. */
async function post(path: string, options: PostOptions = {}): Promise<Response> {
  const { token, cookie } = await csrfForForm(env, null);
  const cookies = [options.session ?? (await sessionFor([ACME])), cookie?.split(";")[0] ?? ""].filter((c) => c !== "");
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", cookie: cookies.join("; ") };
  if (options.origin !== null) headers.origin = options.origin ?? env.HUB_ORIGIN;
  const csrf = options.csrf ?? "valid";
  const fields: Record<string, string> = csrf === "none" ? {} : { csrf: csrf === "valid" ? token : `${token}x` };
  const body = new URLSearchParams({ ...fields, ...options.fields }).toString();
  return exports.default.fetch(`${ORIGIN}/${options.installationId ?? ACME}${path}`, { method: "POST", headers, body, redirect: "manual" });
}

async function bindingCount(installationId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM repo_bindings WHERE installation_id = ?1").bind(installationId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Everything console.log was called with, one line per call. */
function lines(log: MockInstance): string {
  return log.mock.calls.map((c) => String(c[0])).join("\n");
}

describe("GET /:installationId/agents/:agentId", () => {
  it("shows the agent, its bindings with a bound date, its runs and the maintenance commands", async () => {
    await bind(tenantDb(env.DB, ACME), acme.repoId, "deploy:staging", acme.agentId, Date.UTC(2026, 7, 12));
    const res = await get(`/${ACME}/agents/${acme.agentId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<h1>${acme.agentId}</h1>`);
    expect(html).toContain(`${acme.agentId}.local`);
    expect(html).toContain(D.bindings.title);
    expect(html).toContain(acme.fullName);
    expect(html).toContain("Aug 12, 2026");
    expect(html).toContain(D.runs.title);
    expect(html).toContain(acme.runId);
    expect(html).toContain(D.maintenance.title);
    expect(html).toContain(D.maintenance.upgradeCommand);
    expect(html).toContain(`action="/${ACME}/agents/${acme.agentId}/revoke"`);
    expect(html).toContain(`action="/${ACME}/agents/${acme.agentId}/bindings/unbind"`);
  });

  it("shows the OS release in the platform cell, falling back to the raw os", async () => {
    await env.DB.prepare("UPDATE agents SET os = ?2, os_release = ?3 WHERE installation_id = ?1").bind(ACME, "linux", "Ubuntu 22.04").run();
    const html = await (await get(`/${ACME}/agents/${acme.agentId}`)).text();
    expect(html).toContain("Ubuntu 22.04");
    await env.DB.prepare("UPDATE agents SET os = ?2, os_release = NULL WHERE installation_id = ?1").bind(ACME, "linux").run();
    const plain = await (await get(`/${ACME}/agents/${acme.agentId}`)).text();
    expect(plain).not.toContain("Ubuntu 22.04");
    expect(plain).toContain("linux");
  });

  it("escapes the stored name and hostname", async () => {
    await env.DB.prepare("UPDATE agents SET name = '<script>alert(1)</script>', hostname = '<b>host</b>' WHERE installation_id = ?1").bind(ACME).run();
    const html = await (await get(`/${ACME}/agents/${acme.agentId}`)).text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;host&lt;/b&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<b>host</b>");
  });

  it("answers 404 for another installation's agent, a missing one, and an installation the session does not cover", async () => {
    for (const path of [`/${ACME}/agents/${umbrella.agentId}`, `/${ACME}/agents/agt_nope`, `/${UMBRELLA}/agents/${umbrella.agentId}`]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain(S.dashboard.notFoundTitle);
    }
  });

  it("shows a revoked agent with no revoke or unbind forms", async () => {
    await post(`/agents/${acme.agentId}/revoke`);
    const html = await (await get(`/${ACME}/agents/${acme.agentId}`)).text();
    expect(html).toContain(S.agents.status.revoked);
    expect(html).not.toContain("/revoke\"");
    expect(html).not.toContain("/bindings/unbind");
  });

  it("shows a notice only from the known ones", async () => {
    const known = await (await get(`/${ACME}/agents/${acme.agentId}?notice=unbound`)).text();
    expect(known).toContain(S.agents.notices.unbound);
    const unknown = await (await get(`/${ACME}/agents/${acme.agentId}?notice=%3Cb%3Ex`)).text();
    expect(unknown).not.toContain("<b>x");
  });
});

describe("POST /:installationId/agents/:agentId/revoke", () => {
  it("revokes the agent, drops its bindings, logs it, and returns to the agent page", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await post(`/agents/${acme.agentId}/revoke`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${ACME}/agents/${acme.agentId}?notice=revoked`);
    const row = await env.DB.prepare("SELECT status, revoked_at FROM agents WHERE installation_id = ?1 AND agent_id = ?2").bind(ACME, acme.agentId).first<{ status: string; revoked_at: number | null }>();
    expect(row?.status).toBe("revoked");
    expect(row?.revoked_at).not.toBeNull();
    expect(await bindingCount(ACME)).toBe(0);
    expect(lines(log)).toContain("agent_revoke");
  });

  it("leaves other installations alone", async () => {
    await post(`/agents/${acme.agentId}/revoke`);
    const row = await env.DB.prepare("SELECT revoked_at FROM agents WHERE installation_id = ?1").bind(UMBRELLA).first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).toBeNull();
    expect(await bindingCount(UMBRELLA)).toBe(1);
  });

  it("refuses a user who does not administer the account", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await post(`/agents/${acme.agentId}/revoke`, { session: await sessionFor([ACME], OWNER + 1) });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(P.notAdmin);
    expect(await bindingCount(ACME)).toBe(1);
    expect(lines(log)).toContain("agent_revoke_not_admin");
  });

  it("refuses a missing, wrong or absent csrf token, and a foreign Origin", async () => {
    for (const options of [{ csrf: "wrong" }, { csrf: "none" }, { origin: "https://evil.example" }] as PostOptions[]) {
      const res = await post(`/agents/${acme.agentId}/revoke`, options);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(P.csrf);
    }
    expect(await bindingCount(ACME)).toBe(1);
  });

  it("answers 404 for another installation's agent, a missing agent, an uncovered installation, and an agent already revoked", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const agentId of [umbrella.agentId, "agt_nope"]) {
      const res = await post(`/agents/${agentId}/revoke`);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain(P.notFound);
    }
    const uncovered = await post(`/agents/${umbrella.agentId}/revoke`, { installationId: UMBRELLA });
    expect(uncovered.status).toBe(404);
    expect(await uncovered.text()).toContain(S.dashboard.notFoundTitle);
    expect((await post(`/agents/${acme.agentId}/revoke`)).status).toBe(303);
    expect((await post(`/agents/${acme.agentId}/revoke`)).status).toBe(404);
    const row = await env.DB.prepare("SELECT revoked_at FROM agents WHERE installation_id = ?1").bind(UMBRELLA).first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).toBeNull();
    expect(lines(log)).toContain("agent_not_found");
  });
});

describe("POST /:installationId/agents/:agentId/bindings/unbind", () => {
  it("removes one binding, logs it, and returns to the agent page", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await bind(tenantDb(env.DB, ACME), acme.repoId, "deploy:staging", acme.agentId);
    const res = await post(`/agents/${acme.agentId}/bindings/unbind`, { fields: { repo_id: String(acme.repoId), target: "deploy:staging" } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${ACME}/agents/${acme.agentId}?notice=unbound`);
    const left = await env.DB.prepare("SELECT target FROM repo_bindings WHERE installation_id = ?1").bind(ACME).all<{ target: string }>();
    expect(left.results.map((r) => r.target)).toEqual(["checks"]);
    expect(lines(log)).toContain("repo_unbind");
  });

  it("answers 404 for a binding the agent does not hold, and for another installation's repo", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const fields of [
      { repo_id: String(acme.repoId), target: "deploy:staging" },
      { repo_id: String(umbrella.repoId), target: "checks" },
      { repo_id: "abc", target: "checks" },
      { repo_id: String(acme.repoId), target: "nonsense" },
    ]) {
      const res = await post(`/agents/${acme.agentId}/bindings/unbind`, { fields });
      expect(res.status).toBe(404);
      expect(await res.text()).toContain(P.notFound);
    }
    expect(await bindingCount(ACME)).toBe(1);
    expect(await bindingCount(UMBRELLA)).toBe(1);
    expect(lines(log)).toContain("agent_unbind_not_found");
  });

  it("answers 404 for another installation's agent", async () => {
    const res = await post(`/agents/${umbrella.agentId}/bindings/unbind`, { fields: { repo_id: String(umbrella.repoId), target: "checks" } });
    expect(res.status).toBe(404);
    expect(await bindingCount(UMBRELLA)).toBe(1);
  });

  it("refuses a user who does not administer the account", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await post(`/agents/${acme.agentId}/bindings/unbind`, { fields: { repo_id: String(acme.repoId), target: "checks" }, session: await sessionFor([ACME], OWNER + 1) });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(P.notAdmin);
    expect(await bindingCount(ACME)).toBe(1);
    expect(lines(log)).toContain("agent_unbind_not_admin");
  });

  it("refuses a missing, wrong or absent csrf token, and a foreign Origin", async () => {
    const fields = { repo_id: String(acme.repoId), target: "checks" };
    for (const options of [{ csrf: "wrong" }, { csrf: "none" }, { origin: "https://evil.example" }] as PostOptions[]) {
      const res = await post(`/agents/${acme.agentId}/bindings/unbind`, { ...options, fields });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(P.csrf);
    }
    expect(await bindingCount(ACME)).toBe(1);
  });
});

describe("bind", () => {
  it("records when the binding was made", async () => {
    const row = await env.DB.prepare("SELECT bound_at FROM repo_bindings WHERE installation_id = ?1").bind(ACME).first<{ bound_at: number | null }>();
    expect(row?.bound_at).not.toBeNull();
  });
});

interface BudgetRow {
  budget_cpus: number | null;
  budget_memory_bytes: number | null;
}

async function budgetRow(agentId: string): Promise<BudgetRow | null> {
  return env.DB.prepare("SELECT budget_cpus, budget_memory_bytes FROM agents WHERE installation_id = ?1 AND agent_id = ?2").bind(ACME, agentId).first<BudgetRow>();
}

describe("the Capacity card", () => {
  it("says the capacity is unavailable for an agent that never reported it, with no budget form", async () => {
    const html = await (await get(`/${ACME}/agents/${acme.agentId}`)).text();
    expect(html).toContain(S.agents.capacity.unavailable);
    expect(html).not.toContain(`/agents/${acme.agentId}/budget"`);
  });

  it("shows host, budget, usage, jobs and the form for a reported capacity, and the chip on the list", async () => {
    await env.DB.prepare("UPDATE agents SET last_capacity = ?2, last_capacity_at = ?3 WHERE installation_id = ?1")
      .bind(ACME, JSON.stringify(sanitizeCapacity(capacityFrame({ backing_off: true }))), 1_000)
      .run();
    const html = await (await get(`/${ACME}/agents/${acme.agentId}`)).text();
    expect(html).toContain(S.agents.capacity.hostValue("16", "32 GiB"));
    expect(html).toContain(S.agents.capacity.cpuUse("5", "8"));
    expect(html).toContain(S.agents.capacity.memoryUse("4 GiB", "16 GiB"));
    expect(html).toContain(">unit</td><td>main</td>");
    expect(html).toContain(`action="/${ACME}/agents/${acme.agentId}/budget"`);
    const list = await (await get(`/${ACME}/agents`)).text();
    expect(list).toContain(S.agents.capacity.chip("5", "8", "4", "16 GiB"));
  });

  it("shows that there is no memory budget instead of a zero budget", async () => {
    await env.DB.prepare("UPDATE agents SET last_capacity = ?2, last_capacity_at = ?3 WHERE installation_id = ?1")
      .bind(ACME, JSON.stringify(sanitizeCapacity(capacityFrame({ budget_memory_bytes: 0 }))), 1_000)
      .run();
    const html = await (await get(`/${ACME}/agents/${acme.agentId}`)).text();
    expect(html).toContain(S.agents.capacity.hostValue("8", S.agents.capacity.noMemoryBudget));
    expect(html).toContain(S.agents.capacity.memoryUse("4 GiB", null));
    const list = await (await get(`/${ACME}/agents`)).text();
    expect(list).toContain(S.agents.capacity.chip("5", "8", "4", null));
  });
});

describe("POST /:installationId/agents/:agentId/budget", () => {
  it("stores the override, logs it and returns to the agent page", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await post(`/agents/${acme.agentId}/budget`, { fields: { cpus: "6", memory_gib: "12" } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${ACME}/agents/${acme.agentId}?notice=budgetSaved`);
    expect(await budgetRow(acme.agentId)).toEqual({ budget_cpus: 6, budget_memory_bytes: 12 * 1024 ** 3 });
    expect(lines(log)).toContain("agent_budget");
  });

  it("clears it on reset and on blank fields", async () => {
    await post(`/agents/${acme.agentId}/budget`, { fields: { cpus: "6", memory_gib: "12" } });
    const res = await post(`/agents/${acme.agentId}/budget`, { fields: { action: "reset", cpus: "6" } });
    expect(res.headers.get("location")).toBe(`/${ACME}/agents/${acme.agentId}?notice=budgetReset`);
    expect(await budgetRow(acme.agentId)).toEqual({ budget_cpus: null, budget_memory_bytes: null });
  });

  it.each([
    ["cpus", { cpus: "0" }, P.budgetCpus],
    ["cpus", { cpus: "2000" }, P.budgetCpus],
    ["memory", { memory_gib: "0.1" }, P.budgetMemory],
    ["memory", { memory_gib: "abc" }, P.budgetMemory],
  ])("refuses a bad %s value with 400", async (_name, fields, message) => {
    const res = await post(`/agents/${acme.agentId}/budget`, { fields });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(message);
    expect(await budgetRow(acme.agentId)).toEqual({ budget_cpus: null, budget_memory_bytes: null });
  });

  it("refuses a non-admin, a bad csrf token, another installation's agent and a revoked agent", async () => {
    const body = { fields: { cpus: "6" } };
    const notAdmin = await post(`/agents/${acme.agentId}/budget`, { ...body, session: await sessionFor([ACME], OWNER + 1) });
    expect(notAdmin.status).toBe(403);
    expect(await notAdmin.text()).toContain(P.notAdmin);
    const csrf = await post(`/agents/${acme.agentId}/budget`, { ...body, csrf: "wrong" });
    expect(csrf.status).toBe(403);
    expect((await post(`/agents/${umbrella.agentId}/budget`, body)).status).toBe(404);
    await post(`/agents/${acme.agentId}/revoke`);
    expect((await post(`/agents/${acme.agentId}/budget`, body)).status).toBe(404);
    expect(await budgetRow(acme.agentId)).toEqual({ budget_cpus: null, budget_memory_bytes: null });
  });

  it("pushes the override to a connected agent that sent its host size, and the stored one on its next hello", async () => {
    const agent = { agentId: acme.agentId, credential: acme.credential, stub: env.AGENT_DO.get(env.AGENT_DO.idFromName(acme.agentId)) };
    const hello = { v: 1, type: "hello", protocol_version: PROTOCOL_MAX, agent_version: AGENT_VERSION, host_cpus: 16, host_memory_bytes: 32 * 1024 ** 3 };
    const first = await connect(agent);
    first.send(hello);
    expect(await first.next()).toMatchObject({ type: "welcome" });
    expect(await first.next()).toEqual({ v: 1, type: "budget", cpus: null, memory_bytes: null });
    await post(`/agents/${acme.agentId}/budget`, { fields: { cpus: "6", memory_gib: "12" } });
    expect(await first.next()).toEqual({ v: 1, type: "budget", cpus: 6, memory_bytes: 12 * 1024 ** 3 });
    first.ws.close(1000, "done");
    const second = await connect(agent);
    second.send(hello);
    expect(await second.next()).toMatchObject({ type: "welcome" });
    expect(await second.next()).toEqual({ v: 1, type: "budget", cpus: 6, memory_bytes: 12 * 1024 ** 3 });
    second.ws.close(1000, "done");
  });
});
