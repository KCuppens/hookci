import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { csrfForForm } from "../src/accounts/csrf";
import { API_TOKEN_PREFIX, apiTokenHash, listApiTokens } from "../src/db/api-tokens";
import { tenantDb } from "../src/db/tenant";
import { issueSession } from "../src/oauth/state";
import { authenticateMcpToken } from "../src/routes/mcp-auth";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { seedTenant, type Tenant } from "./helpers/tenants";

const ORIGIN = "https://hub.test";
const ACME = 42;
const OTHER = 43;
const A = S.apiTokens;

let acme: Tenant;

beforeEach(async () => {
	await clearTables();
	acme = await seedTenant(env, { installationId: ACME, teamId: "T0ACME" });
	await seedTenant(env, { installationId: OTHER, teamId: "T0OTHER" });
});

async function sessionFor(installationIds: number[]): Promise<string> {
	const setCookie = await issueSession(env, { installationIds, githubUserId: 7001, githubLogin: "octocat" }, testClock.now());
	return setCookie.split(";")[0] ?? "";
}

function get(path: string, cookie?: string): Promise<Response> {
	const headers: Record<string, string> = {};
	if (cookie !== undefined) headers.cookie = cookie;
	return exports.default.fetch(`${ORIGIN}${path}`, { headers, redirect: "manual" });
}

interface PostOptions {
	session?: string | null;
	origin?: string | null;
	csrf?: "valid" | "wrong" | "none";
	body?: Record<string, string>;
}

/** Posts a browser form: a session cookie, a same-origin csrf cookie and field, like run-actions.test.ts's post(). */
async function post(path: string, options: PostOptions = {}): Promise<Response> {
	const { token, cookie } = await csrfForForm(env, null);
	const session = options.session === undefined ? await sessionFor([ACME]) : options.session;
	const cookies = [session, cookie?.split(";")[0] ?? null].filter((c): c is string => c !== null);
	const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
	if (cookies.length > 0) headers.cookie = cookies.join("; ");
	const fields: Record<string, string> = { ...(options.body ?? {}) };
	if (options.origin !== null) headers.origin = options.origin ?? env.HUB_ORIGIN;
	const csrf = options.csrf ?? "valid";
	if (csrf !== "none") fields.csrf = csrf === "valid" ? token : `${token}x`;
	return exports.default.fetch(`${ORIGIN}${path}`, { method: "POST", headers, body: new URLSearchParams(fields).toString(), redirect: "manual" });
}

/** Pulls the raw token out of the reveal page's `<code>...</code>` body. */
function extractRevealedToken(html: string): string {
	return /<code>([^<]+)<\/code>/.exec(html)?.[1] ?? "";
}

describe("POST /:installationId/tokens", () => {
	it("creates a token and shows it once, with a no-store header", async () => {
		const res = await post(`/${ACME}/tokens`, { body: { name: "Claude Code" } });
		expect(res.status).toBe(201);
		expect(res.headers.get("cache-control")).toContain("no-store");
		const html = await res.text();
		const token = extractRevealedToken(html);
		expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);

		const rows = await listApiTokens(tenantDb(env.DB, ACME));
		expect(rows).toHaveLength(2);
		expect(rows[0]?.name).toBe("Claude Code");
		expect(rows[0]?.revoked_at).toBeNull();
		expect(rows[0]?.token_hash).toBe(await apiTokenHash(token));

		const row = await authenticateMcpToken(env, `Bearer ${token}`, undefined);
		expect(row.installation_id).toBe(ACME);
	});

	it("rejects a blank name without creating a row", async () => {
		const res = await post(`/${ACME}/tokens`, { body: { name: "   " } });
		expect(res.status).toBe(400);
		expect(await res.text()).toContain(A.nameRequired);
		expect(await listApiTokens(tenantDb(env.DB, ACME))).toHaveLength(1);
	});

	it("trims the name", async () => {
		await post(`/${ACME}/tokens`, { body: { name: "  spaced  " } });
		const rows = await listApiTokens(tenantDb(env.DB, ACME));
		expect(rows[0]?.name).toBe("spaced");
	});

	describe("refusals", () => {
		it("404s without a session, and for an installation the session does not cover", async () => {
			expect((await post(`/${ACME}/tokens`, { session: null, body: { name: "x" } })).status).toBe(404);
			const other = await sessionFor([OTHER]);
			expect((await post(`/${ACME}/tokens`, { session: other, body: { name: "x" } })).status).toBe(404);
		});

		it("403s with no csrf field, a wrong csrf field, or a cross-origin request", async () => {
			for (const options of [{ csrf: "none" as const }, { csrf: "wrong" as const }, { origin: "https://evil.example" }]) {
				const res = await post(`/${ACME}/tokens`, { ...options, body: { name: "x" } });
				expect(res.status).toBe(403);
				expect(await res.text()).toContain(A.csrf);
			}
			expect(await listApiTokens(tenantDb(env.DB, ACME))).toHaveLength(1);
		});
	});
});

describe("POST /:installationId/tokens/:tokenId/revoke", () => {
	it("revokes a token and redirects back to settings; the token stops authenticating", async () => {
		const created = await post(`/${ACME}/tokens`, { body: { name: "to revoke" } });
		const token = extractRevealedToken(await created.text());
		const rows = await listApiTokens(tenantDb(env.DB, ACME));
		const tokenId = rows[0]?.token_id ?? "";

		const res = await post(`/${ACME}/tokens/${tokenId}/revoke`);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe(`/${ACME}/settings`);

		const after = await listApiTokens(tenantDb(env.DB, ACME));
		expect(after[0]?.revoked_at).not.toBeNull();
		await expect(authenticateMcpToken(env, `Bearer ${token}`, undefined)).rejects.toThrow();
	});

	it("rejects authentication when the installation is suspended or deleted", async () => {
		const res = await post(`/${ACME}/tokens`, { body: { name: "suspension check" } });
		const token = extractRevealedToken(await res.text());

		// Suspended
		await env.DB.prepare("UPDATE installations SET suspended_at = 12345 WHERE id = ?").bind(ACME).run();
		await expect(authenticateMcpToken(env, `Bearer ${token}`, undefined)).rejects.toThrow();

		// Restored
		await env.DB.prepare("UPDATE installations SET suspended_at = NULL WHERE id = ?").bind(ACME).run();
		const row = await authenticateMcpToken(env, `Bearer ${token}`, undefined);
		expect(row.installation_id).toBe(ACME);

		// Deleted
		await env.DB.prepare("UPDATE installations SET deleted_at = 12345 WHERE id = ?").bind(ACME).run();
		await expect(authenticateMcpToken(env, `Bearer ${token}`, undefined)).rejects.toThrow();

		// Clean up for other tests
		await env.DB.prepare("UPDATE installations SET deleted_at = NULL WHERE id = ?").bind(ACME).run();
	});

	it("never touches another installation's token", async () => {
		await post(`/${ACME}/tokens`, { body: { name: "acme token" } });
		const tokenId = (await listApiTokens(tenantDb(env.DB, ACME)))[0]?.token_id ?? "";
		const otherSession = await sessionFor([OTHER]);
		expect((await post(`/${OTHER}/tokens/${tokenId}/revoke`, { session: otherSession })).status).toBe(303);
		expect((await listApiTokens(tenantDb(env.DB, ACME)))[0]?.revoked_at).toBeNull();
	});

	it("404s without a session covering the installation, and 403s on a bad csrf", async () => {
		expect((await post(`/${ACME}/tokens/abc/revoke`, { session: null })).status).toBe(404);
		expect((await post(`/${ACME}/tokens/abc/revoke`, { csrf: "wrong" })).status).toBe(403);
	});
});

describe("the Settings tab's token card", () => {
	async function settingsPage(): Promise<string> {
		const res = await get(`/${ACME}/settings`, await sessionFor([ACME]));
		expect(res.status).toBe(200);
		return res.text();
	}

	it("lists a created token's name and id, but never its hash or raw value", async () => {
		const created = await post(`/${ACME}/tokens`, { body: { name: "Listed Token" } });
		const token = extractRevealedToken(await created.text());
		const row = (await listApiTokens(tenantDb(env.DB, ACME)))[0];
		expect(row).toBeDefined();

		const settings = await settingsPage();
		expect(settings).toContain("Listed Token");
		expect(settings).toContain(row?.token_id ?? "");
		expect(settings).not.toContain(token);
		expect(settings).not.toContain(row?.token_hash ?? "");
	});

	it("shows an empty state with no tokens, and a revoked marker after revoking", async () => {
		await env.DB.prepare("DELETE FROM api_tokens WHERE installation_id = ?1").bind(ACME).run();
		expect(await settingsPage()).toContain(A.none);

		await post(`/${ACME}/tokens`, { body: { name: "to mark" } });
		const tokenId = (await listApiTokens(tenantDb(env.DB, ACME)))[0]?.token_id ?? "";
		await post(`/${ACME}/tokens/${tokenId}/revoke`);
		const settings = await settingsPage();
		expect(settings).toContain("to mark");
		expect(settings).toContain(A.revoked);
	});
});
