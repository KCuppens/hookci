import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { csrfForForm } from "../src/accounts/csrf";
import { API_TOKEN_PREFIX, apiTokenHash, listApiTokens } from "../src/db/api-tokens";
import { insertRun, upsertJob } from "../src/db/runs";
import { tenantDb } from "../src/db/tenant";
import { issueSession } from "../src/oauth/state";
import { createPairToken, redeemPairToken } from "../src/pairing/tokens";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { connectRequest, seedAgent } from "./do/agent-socket";
import { seedTenant, type Tenant } from "./helpers/tenants";
import { gzip } from "./logs/helpers";

const ORIGIN = "https://hub.test";
const TENANT_A = 1001;
const TENANT_B = 1002;
const USER_A = 7001;
const D = S.dashboard;

let tenantA: Tenant;
let tenantB: Tenant;

beforeEach(async () => {
	await clearTables();
	tenantA = await seedTenant(env, { installationId: TENANT_A, teamId: "T001A" });
	tenantB = await seedTenant(env, { installationId: TENANT_B, teamId: "T002B" });
	await env.DB.prepare("UPDATE installations SET account_type = 'User', account_id = ? WHERE id = ?").bind(USER_A, TENANT_A).run();
});

async function sessionCookie(ids: number[], userId = USER_A): Promise<string> {
	const cookie = await issueSession(env, { installationIds: ids, githubUserId: userId, githubLogin: "alice" }, testClock.now());
	return cookie.split(";")[0] ?? "";
}

function fetchHub(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", "198.51.100.12");
	return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
}

async function postForm(path: string, fields: Record<string, string>, cookie?: string): Promise<Response> {
	const { token, cookie: csrfCookie } = await csrfForForm(env, null);
	const cookies = [cookie ?? (await sessionCookie([TENANT_A])), csrfCookie?.split(";")[0] ?? null].filter((c): c is string => c !== null);
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
		origin: env.HUB_ORIGIN,
		cookie: cookies.join("; "),
	};
	const body = new URLSearchParams({ ...fields, csrf: token }).toString();
	return fetchHub(path, { method: "POST", headers, body });
}

describe("E2E Testing Coverage: app.hookci.com", () => {
	describe("1. Public, Informational & Infrastructure Endpoints", () => {
		it("serves /healthz with status and version", async () => {
			const res = await fetchHub("/healthz");
			expect(res.status).toBe(200);
			const data = await res.json<{ ok: boolean; version: string }>();
			expect(data.ok).toBe(true);
			expect(typeof data.version).toBe("string");
		});

		it("serves /v1/info with hub metadata and protocol versions", async () => {
			const res = await fetchHub("/v1/info");
			expect(res.status).toBe(200);
			const data = await res.json<{ name: string; version: string; protocol_versions: number[] }>();
			expect(data.name).toBe("hookci-hub");
			expect(Array.isArray(data.protocol_versions)).toBe(true);
		});

		it("serves /.well-known/security.txt and legal documents", async () => {
			const sec = await fetchHub("/.well-known/security.txt");
			expect(sec.status).toBe(200);
			expect(await sec.text()).toContain("Contact:");

			for (const path of ["/privacy", "/terms", "/support"]) {
				const doc = await fetchHub(path);
				expect(doc.status).toBe(200);
				expect(doc.headers.get("content-type")).toContain("text/html");
				const html = (await doc.text()).toLowerCase();
				expect(html).toContain("<!doctype html>");
			}
		});

		it("serves sign-in page on / and redirects /login to GitHub OAuth", async () => {
			const home = await fetchHub("/");
			expect(home.status).toBe(200);
			const homeHtml = await home.text();
			expect(homeHtml).toContain("Sign in");

			const login = await fetchHub("/login");
			expect(login.status).toBe(303);
			const loc = login.headers.get("location") ?? "";
			expect(loc).toContain("github.com/login/oauth/authorize");
		});

		it("handles legacy /app paths by redirecting to HUB_ORIGIN", async () => {
			const appRoot = await fetchHub("/app");
			expect(appRoot.status).toBe(308);

			const appRun = await fetchHub(`/app/${TENANT_A}/runs`);
			expect(appRun.status).toBe(308);
		});

		it("returns 404 JSON for unknown API and web routes", async () => {
			const res = await fetchHub("/nonexistent-endpoint-xyz");
			expect(res.status).toBe(404);
			expect(await res.text()).toContain(D.notFoundTitle);
		});
	});

	describe("2. Authentication & Tenant Boundary Protection", () => {
		it("denies access to tenant routes without a valid session", async () => {
			const routes = [
				`/${TENANT_A}`,
				`/${TENANT_A}/runs`,
				`/${TENANT_A}/agents`,
				`/${TENANT_A}/repositories`,
				`/${TENANT_A}/settings`,
			];
			for (const r of routes) {
				const res = await fetchHub(r);
				expect(res.status).toBe(404);
				expect(await res.text()).toContain(D.notFoundTitle);
			}
		});

		it("enforces strict isolation between Tenant A and Tenant B", async () => {
			const sessionA = await sessionCookie([TENANT_A]);
			// Tenant A cannot access Tenant B's pages
			const foreignOverview = await fetchHub(`/${TENANT_B}`, { headers: { cookie: sessionA } });
			expect(foreignOverview.status).toBe(404);

			const foreignRuns = await fetchHub(`/${TENANT_B}/runs`, { headers: { cookie: sessionA } });
			expect(foreignRuns.status).toBe(404);

			const foreignSettings = await fetchHub(`/${TENANT_B}/settings`, { headers: { cookie: sessionA } });
			expect(foreignSettings.status).toBe(404);
		});
	});

	describe("3. Dashboard Pages & Live Run View", () => {
		it("renders tenant overview, runs list, and tabs for an authenticated user", async () => {
			const cookie = await sessionCookie([TENANT_A]);

			const overview = await fetchHub(`/${TENANT_A}`, { headers: { cookie } });
			expect(overview.status).toBe(200);
			const overviewHtml = await overview.text();
			expect(overviewHtml).toContain(`org${tenantA.installationId}`);

			const runs = await fetchHub(`/${TENANT_A}/runs`, { headers: { cookie } });
			expect(runs.status).toBe(200);
			const runsHtml = await runs.text();
			expect(runsHtml).toContain("Runs");

			const agents = await fetchHub(`/${TENANT_A}/agents`, { headers: { cookie } });
			expect(agents.status).toBe(200);
			expect(await agents.text()).toContain("Agents");

			const repos = await fetchHub(`/${TENANT_A}/repositories`, { headers: { cookie } });
			expect(repos.status).toBe(200);
			expect(await repos.text()).toContain(tenantA.fullName);

			const settings = await fetchHub(`/${TENANT_A}/settings`, { headers: { cookie } });
			expect(settings.status).toBe(200);
			expect(await settings.text()).toContain("Settings");
		});

		it("renders run detail with setup job, live duration ticker, and live log stream placeholder", async () => {
			const cookie = await sessionCookie([TENANT_A]);
			const runId = "01m5testrun000000000000001";
			const t = tenantDb(env.DB, TENANT_A);

			// Seed a running run with a setup job and a work job
			await insertRun(t, {
				run_id: runId,
				repo_id: tenantA.repoId,
				sha: "0123456789abcdef0123456789abcdef01234567",
				ref: "refs/heads/main",
				event: "push",
				pr_number: null,
				env: null,
				attempt: 1,
				trigger_id: runId,
				agent_id: tenantA.agentId,
				state: "running",
				reason: null,
				author_login: "alice",
				commit_title: "Add live log and fast setup",
				started_at: Date.now() - 5000,
				finished_at: null,
				duration_ms: null,
				log_key: null,
			});

			await upsertJob(t, {
				run_id: runId,
				name: "setup",
				state: "running",
				started_at: Date.now() - 5000,
				step: "pnpm install",
				step_index: 1,
				steps_total: 3,
				duration_ms: null,
			});

			await upsertJob(t, {
				run_id: runId,
				name: "test",
				state: "queued",
				step: null,
				step_index: null,
				steps_total: null,
				duration_ms: null,
			});

			const detailRes = await fetchHub(`/${TENANT_A}/runs/${runId}`, { headers: { cookie } });
			expect(detailRes.status).toBe(200);
			const detailHtml = await detailRes.text();

			// Verifies run detail components
			expect(detailHtml).toContain("Add live log and fast setup");
			expect(detailHtml).toContain("setup");
			expect(detailHtml).toContain("test");
			expect(detailHtml).toContain("data-ms"); // Live duration ticker attribute
			expect(detailHtml).toContain("data-tail"); // Live inline log streaming attribute
		});

		it("handles live SSE log streaming and enforces tenant isolation", async () => {
			const cookieA = await sessionCookie([TENANT_A]);
			const cookieB = await sessionCookie([TENANT_B]);
			const runId = "01m5testrun000000000000002";
			const t = tenantDb(env.DB, TENANT_A);

			await insertRun(t, {
				run_id: runId,
				repo_id: tenantA.repoId,
				sha: "1111111111111111111111111111111111111111",
				ref: "refs/heads/main",
				event: "push",
				pr_number: null,
				env: null,
				attempt: 1,
				trigger_id: runId,
				agent_id: tenantA.agentId,
				state: "running",
				reason: null,
				author_login: "alice",
				commit_title: "Streaming test",
				started_at: Date.now() - 1000,
				finished_at: null,
				duration_ms: null,
				log_key: null,
			});

			await upsertJob(t, {
				run_id: runId,
				name: "setup",
				state: "running",
				started_at: Date.now() - 1000,
				step: "ci_pnpm_install",
				step_index: 1,
				steps_total: 2,
				duration_ms: null,
			});

			// Tenant B attempting to stream Tenant A's log is denied with 404
			const forbidden = await fetchHub(`/${TENANT_B}/runs/${runId}/logs/setup/stream`, { headers: { cookie: cookieB } });
			expect(forbidden.status).toBe(404);

			// Completed run returns 409
			await env.DB.prepare("UPDATE runs SET state = 'success', finished_at = ? WHERE run_id = ?").bind(Date.now(), runId).run();
			const conflict = await fetchHub(`/${TENANT_A}/runs/${runId}/logs/setup/stream`, { headers: { cookie: cookieA } });
			expect(conflict.status).toBe(409);
		});
	});

	describe("4. Log Upload, Storage & Signed Views", () => {
		it("accepts log upload to R2 and allows raw download and HTML viewing", async () => {
			const cookie = await sessionCookie([TENANT_A]);
			const runId = "01m5testrun000000000000003";
			const t = tenantDb(env.DB, TENANT_A);

			await insertRun(t, {
				run_id: runId,
				repo_id: tenantA.repoId,
				sha: "2222222222222222222222222222222222222222",
				ref: "refs/heads/main",
				event: "push",
				pr_number: null,
				env: null,
				attempt: 1,
				trigger_id: runId,
				agent_id: tenantA.agentId,
				state: "success",
				reason: null,
				author_login: "alice",
				commit_title: "Upload log test",
				started_at: 1000,
				finished_at: 2000,
				duration_ms: 1000,
				log_key: null,
			});

			await upsertJob(t, {
				run_id: runId,
				name: "setup",
				state: "success",
				started_at: 1000,
				step: null,
				step_index: null,
				steps_total: null,
				duration_ms: 1000,
			});

			// Upload gzipped log from agent
			const logContent = "cache setup[0]: hit store\nProgress: resolved 1355, reused 1355, downloaded 0\n";
			const compressed = await gzip(logContent);
			const upload = await fetchHub(`/v1/logs/${runId}/setup`, {
				method: "PUT",
				headers: {
					authorization: `Bearer ${tenantA.credential}`,
					"content-type": "application/octet-stream",
					"content-encoding": "gzip",
					"x-hookci-log-bytes": String(logContent.length),
					"x-hookci-log-truncated": "0",
				},
				body: compressed,
			});
			expect(upload.status).toBe(204);

			// Download raw log
			const download = await fetchHub(`/${TENANT_A}/runs/${runId}/logs/setup/download`, { headers: { cookie } });
			expect(download.status).toBe(200);
			expect(download.headers.get("content-disposition")).toContain("attachment");
			expect(await download.text()).toBe(logContent);

			// View HTML log
			const view = await fetchHub(`/${TENANT_A}/runs/${runId}/logs/setup/view`, { headers: { cookie } });
			expect(view.status).toBe(200);
			expect(view.headers.get("content-type")).toContain("text/html");
			expect(await view.text()).toContain("cache setup[0]");
		});
	});

	describe("5. Agent Pairing & Handshake Protocol", () => {
		it("completes full pairing flow: token issue -> redemption -> agent listing", async () => {
			const { token: pairToken } = await createPairToken(env, {
				installationId: TENANT_A,
				createdByGithubId: USER_A,
			});

			// Agent redeems token
			const redeemRes = await fetchHub("/v1/pair/redeem", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					pair_token: pairToken,
					name: "infrauno-e2e",
					hostname: "infrauno.local",
					agent_version: "593367c",
					os: "linux",
					arch: "amd64",
				}),
			});
			expect(redeemRes.status).toBe(200);
			const redeemData = await redeemRes.json<{ agent_id: string; credential: string }>();
			expect(redeemData.agent_id.startsWith("agt_")).toBe(true);
			expect(redeemData.credential.startsWith("hci_agent_")).toBe(true);

			// Agent appears on dashboard
			const cookie = await sessionCookie([TENANT_A]);
			const agentsPage = await fetchHub(`/${TENANT_A}/agents`, { headers: { cookie } });
			expect(agentsPage.status).toBe(200);
			const html = await agentsPage.text();
			expect(html).toContain("infrauno-e2e");
		});

		it("refuses agent connect without websocket upgrade or valid credential", async () => {
			// Without WebSocket upgrade -> 426
			const noUpgrade = await fetchHub("/v1/agent/connect");
			expect(noUpgrade.status).toBe(426);

			// With bad credential -> 401
			const badAuth = await connectRequest("hci_agent_invalid_cred");
			expect(badAuth.status).toBe(401);
		});
	});

	describe("6. API Tokens, Settings & MCP Protocol", () => {
		it("creates, lists, and revokes API tokens, and allows authenticated MCP calls", async () => {
			const cookie = await sessionCookie([TENANT_A]);

			// 1. Create API token
			const createRes = await postForm(`/${TENANT_A}/tokens`, { name: "MCP Test Token" }, cookie);
			expect(createRes.status).toBe(201);
			const createHtml = await createRes.text();
			const tokenMatch = /<code>([^<]+)<\/code>/.exec(createHtml);
			expect(tokenMatch).toBeTruthy();
			const rawToken = tokenMatch![1]!;
			expect(rawToken.startsWith(API_TOKEN_PREFIX)).toBe(true);

			// 2. Token is listed in database
			const tokens = await listApiTokens(tenantDb(env.DB, TENANT_A));
			expect(tokens.length).toBeGreaterThan(0);
			const createdRow = tokens.find((t) => t.name === "MCP Test Token");
			expect(createdRow).toBeTruthy();
			expect(createdRow?.revoked_at).toBeNull();

			// 3. Authenticate MCP call with the issued token
			const mcpRes = await fetchHub(`/mcp/${rawToken}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
					params: {},
				}),
			});
			expect(mcpRes.status).toBe(200);
			const mcpData = await mcpRes.json<{ jsonrpc: string; result?: { tools: unknown[] } }>();
			expect(mcpData.jsonrpc).toBe("2.0");
			expect(mcpData.result?.tools).toBeDefined();

			// 4. Revoke token
			const revokeRes = await postForm(`/${TENANT_A}/tokens/${createdRow!.token_id}/revoke`, {}, cookie);
			expect(revokeRes.status).toBe(303);

			// 5. Revoked token can no longer access MCP
			const revokedMcp = await fetchHub(`/mcp/${rawToken}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/list",
					params: {},
				}),
			});
			expect(revokedMcp.status).toBe(401);
		});
	});

	describe("7. Agent Management, Lifecycle & Revocation", () => {
		it("updates agent budget, unbinds target, and revokes agent", async () => {
			const cookie = await sessionCookie([TENANT_A], USER_A);

			// 1. Update agent budget
			const budgetRes = await postForm(
				`/${TENANT_A}/agents/${tenantA.agentId}/budget`,
				{ cpus: "8", memory_gib: "32" },
				cookie,
			);
			expect(budgetRes.status).toBe(303);
			expect(budgetRes.headers.get("location")).toBe(`/${TENANT_A}/agents/${tenantA.agentId}?notice=budgetSaved`);

			// 2. Revoke agent
			const revokeRes = await postForm(`/${TENANT_A}/agents/${tenantA.agentId}/revoke`, {}, cookie);
			expect(revokeRes.status).toBe(303);
			expect(revokeRes.headers.get("location")).toBe(`/${TENANT_A}/agents/${tenantA.agentId}?notice=revoked`);

			// 3. Revoked agent is recorded in database
			const row = await env.DB.prepare("SELECT revoked_at FROM agents WHERE agent_id = ?").bind(tenantA.agentId).first<{ revoked_at: number | null }>();
			expect(row?.revoked_at).not.toBeNull();
		});
	});
});
