// The remote MCP endpoint: bearer-token auth (header and path-fallback forms)
// and the run/agent/repo tools it exposes, scoped to the token's installation.

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revokeApiToken } from "../src/db/api-tokens";
import { tenantDb } from "../src/db/tenant";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { seedTenant, type Tenant } from "./helpers/tenants";
import { seedRun } from "./logs/helpers";

const ORIGIN = "https://hub.test";
const ACME = 71;

let tenant: Tenant;

beforeEach(async () => {
	await clearTables();
	tenant = await seedTenant(env, { installationId: ACME, teamId: "T0ACME" });
	await seedRun(ACME, tenant.repoId, "run_open", null, "build", { state: "queued", started_at: 5, finished_at: null, duration_ms: null });
});

function rpc(method: string, params: unknown, token: string | null = tenant.apiToken, path = "/mcp"): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
	if (token !== null) headers.authorization = `Bearer ${token}`;
	return exports.default.fetch(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}

async function callTool<T>(name: string, args: unknown = {}): Promise<{ result: T; isError: boolean }> {
	const res = await rpc("tools/call", { name, arguments: args });
	expect(res.status).toBe(200);
	const body = await res.json<{ result: { content: [{ type: "text"; text: string }]; isError?: boolean } }>();
	return { result: JSON.parse(body.result.content[0].text) as T, isError: body.result.isError ?? false };
}

describe("auth", () => {
	it("401s with no Authorization header on /mcp", async () => {
		const res = await rpc("tools/list", {}, null);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "auth_failed" });
	});

	it("401s a revoked token", async () => {
		await revokeApiToken(tenantDb(env.DB, ACME), tenant.apiTokenId, testClock.now());
		const res = await rpc("tools/list", {});
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "auth_failed" });
	});

	it("authenticates via the /mcp/:token path when no header is set", async () => {
		const res = await rpc("tools/list", {}, null, `/mcp/${tenant.apiToken}`);
		expect(res.status).toBe(200);
		const body = await res.json<{ result: { tools: { name: string }[] } }>();
		expect(body.result.tools.map((tool) => tool.name).sort()).toEqual(
			["cancel_run", "get_run", "get_run_logs", "list_agents", "list_repositories", "list_runs", "retry_run"].sort(),
		);
	});
});

describe("list_runs", () => {
	it("lists runs for the installation, newest first", async () => {
		const { result } = await callTool<{ runs: { run_id: string; state: string }[] }>("list_runs", {});
		expect(result.runs.map((run) => run.run_id)).toEqual(["run_open", tenant.runId]);
		expect(result.runs[0]?.state).toBe("queued");
	});

	it("filters by repo", async () => {
		const { result } = await callTool<{ runs: { run_id: string }[] }>("list_runs", { repo: tenant.fullName });
		expect(result.runs.map((run) => run.run_id).sort()).toEqual(["run_open", tenant.runId].sort());
	});
});

describe("get_run", () => {
	it("returns the run with its jobs", async () => {
		const { result } = await callTool<{ run_id: string; state: string; jobs: { name: string; state: string }[] }>("get_run", { run_id: tenant.runId });
		expect(result.run_id).toBe(tenant.runId);
		expect(result.state).toBe("failed");
		expect(result.jobs).toEqual([{ name: tenant.job, state: "failed", step: null, step_index: null, steps_total: null, duration_ms: 1 }]);
	});

	it("reports not_found as a tool error for a run from another installation", async () => {
		const other = await seedTenant(env, { installationId: 72, teamId: "T0OTHER" });
		const { result, isError } = await callTool<{ error: string }>("get_run", { run_id: other.runId });
		expect(isError).toBe(true);
		expect(result.error).toBe("not_found");
	});
});

describe("cancel_run", () => {
	it("cancels an open run with no agent holding it", async () => {
		const { result, isError } = await callTool<{ run_id: string; outcome: string }>("cancel_run", { run_id: "run_open" });
		expect(isError).toBe(false);
		expect(result).toEqual({ run_id: "run_open", outcome: "cancelled" });
	});

	it("reports not_open as a tool error for an already-finished run", async () => {
		const { result, isError } = await callTool<{ run_id: string; outcome: string }>("cancel_run", { run_id: tenant.runId });
		expect(isError).toBe(true);
		expect(result).toEqual({ run_id: tenant.runId, outcome: "not_open" });
	});
});

describe("retry_run", () => {
	let savedAgentDo: typeof env.AGENT_DO | undefined;

	afterEach(() => {
		if (savedAgentDo !== undefined) env.AGENT_DO = savedAgentDo;
	});

	it("retries a finished run through its bound agent", async () => {
		savedAgentDo = env.AGENT_DO;
		const stub = {
			async fetch(input: string): Promise<Response> {
				const path = new URL(input).pathname;
				if (path === "/trigger") return Response.json({ trigger_id: "trg_retry_mcp" });
				if (path === "/status") return Response.json({ online: true });
				return new Response("not found", { status: 404 });
			},
		};
		env.AGENT_DO = { idFromName: (name: string) => name, get: () => stub } as unknown as typeof env.AGENT_DO;

		const { result, isError } = await callTool<{ run_id: string; kind: string; state: string }>("retry_run", { run_id: tenant.runId });
		expect(isError).toBe(false);
		expect(result).toEqual({ run_id: tenant.runId, kind: "retried", state: "received" });
	});

	it("reports repo_not_found as a tool error when the run's repo no longer exists", async () => {
		await seedRun(ACME, 999_999, "run_no_repo", null);
		const { result, isError } = await callTool<{ error: string }>("retry_run", { run_id: "run_no_repo" });
		expect(isError).toBe(true);
		expect(result.error).toBe("repo_not_found");
	});
});

describe("get_run_logs", () => {
	it("returns available: false for a job with no log yet", async () => {
		const { result, isError } = await callTool<{ available: boolean }>("get_run_logs", { run_id: "run_open", job: "build" });
		expect(isError).toBe(false);
		expect(result).toEqual({ available: false });
	});

	it("reports not_found as a tool error for a job that does not exist on the run", async () => {
		const { result, isError } = await callTool<{ error: string }>("get_run_logs", { run_id: tenant.runId, job: "missing" });
		expect(isError).toBe(true);
		expect(result.error).toBe("not_found");
	});

	it("returns the stored log text", async () => {
		const { result, isError } = await callTool<{ available: boolean; text: string; truncated: boolean }>("get_run_logs", { run_id: tenant.runId, job: tenant.job });
		expect(isError).toBe(false);
		expect(result.available).toBe(true);
		expect(result.text).toContain("secret log");
		expect(result.truncated).toBe(false);
	});
});

describe("list_agents", () => {
	it("lists the installation's agents", async () => {
		const { result } = await callTool<{ agents: { agent_id: string; name: string; status: string }[] }>("list_agents");
		expect(result.agents.map((agent) => agent.agent_id)).toEqual([tenant.agentId]);
		expect(result.agents[0]).toMatchObject({ name: tenant.agentId, status: "offline" });
	});
});

describe("list_repositories", () => {
	it("lists the installation's repositories", async () => {
		const { result } = await callTool<{ repositories: { repo_id: number; full_name: string; default_branch: string }[] }>("list_repositories");
		expect(result.repositories).toEqual([{ repo_id: tenant.repoId, full_name: tenant.fullName, default_branch: "main" }]);
	});
});
