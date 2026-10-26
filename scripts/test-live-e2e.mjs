#!/usr/bin/env node
/**
 * HookCI Live Production E2E Verification Script
 * Validates endpoints on hookci.com and app.hookci.com.
 *
 * Usage: node scripts/test-live-e2e.mjs
 */

const HOOKCI_COM = "https://hookci.com";
const APP_HOOKCI_COM = "https://app.hookci.com";

let passed = 0;
let failed = 0;

function assert(condition, message) {
	if (condition) {
		console.log(`  ✓ ${message}`);
		passed++;
	} else {
		console.error(`  ✗ FAIL: ${message}`);
		failed++;
	}
}

async function checkUrl(url, init = {}) {
	try {
		const res = await fetch(url, { redirect: "manual", ...init });
		return { ok: true, status: res.status, headers: res.headers, text: await res.text() };
	} catch (err) {
		return { ok: false, error: err.message };
	}
}

async function main() {
	console.log("=== HookCI Live Production E2E Verification ===");

	// 1. Marketing & Documentation (hookci.com)
	const compare = await checkUrl(`${HOOKCI_COM}/compare/github-actions/`);
	assert(compare.status === 200, `Compare page returned 200 (got ${compare.status})`);

	const pricing = await checkUrl(`${HOOKCI_COM}/pricing/`);
	assert(pricing.status === 200, `Pricing page returned 200 (got ${pricing.status})`);

	const search = await checkUrl(`${HOOKCI_COM}/docs/search.json`);
	assert(search.status === 200, `Docs search index returned 200 (got ${search.status})`);
	const searchItems = JSON.parse(search.text);
	assert(Array.isArray(searchItems) && searchItems.length > 20, `Search index has ${searchItems.length} entries`);
	// 2. Public & System Endpoints (app.hookci.com)
	console.log("\n[2. app.hookci.com Public & Info Endpoints]");
	const healthz = await checkUrl(`${APP_HOOKCI_COM}/healthz`);
	assert(healthz.status === 200, `/healthz returned 200 (got ${healthz.status})`);
	const healthzJson = JSON.parse(healthz.text);
	assert(healthzJson.ok === true && typeof healthzJson.version === "string", "/healthz returns valid JSON payload");

	const v1Info = await checkUrl(`${APP_HOOKCI_COM}/v1/info`);
	assert(v1Info.status === 200, `/v1/info returned 200 (got ${v1Info.status})`);

	const security = await checkUrl(`${APP_HOOKCI_COM}/.well-known/security.txt`);
	assert(security.status === 200, `/.well-known/security.txt returned 200 (got ${security.status})`);
	assert(security.text.includes("Contact:"), "security.txt includes Contact field");

	const privacy = await checkUrl(`${APP_HOOKCI_COM}/privacy`);
	assert(privacy.status === 200, `/privacy returned 200 (got ${privacy.status})`);

	const terms = await checkUrl(`${APP_HOOKCI_COM}/terms`);
	assert(terms.status === 200, `/terms returned 200 (got ${terms.status})`);

	const support = await checkUrl(`${APP_HOOKCI_COM}/support`);
	assert(support.status === 200, `/support returned 200 (got ${support.status})`);

	const appLanding = await checkUrl(`${APP_HOOKCI_COM}/`);
	assert(appLanding.status === 200, `Sign-in landing returned 200 (got ${appLanding.status})`);
	assert(appLanding.text.includes("Sign in"), "Sign-in landing contains sign in action");

	const loginRedirect = await checkUrl(`${APP_HOOKCI_COM}/login`);
	assert(loginRedirect.status === 303, `/login returns 303 redirect (got ${loginRedirect.status})`);
	assert(loginRedirect.headers.get("location")?.includes("github.com/login/oauth"), `/login redirects to GitHub OAuth`);

	const appLegacyRedirect = await checkUrl(`${APP_HOOKCI_COM}/app`);
	assert(appLegacyRedirect.status === 308, `/app returns 308 permanent redirect (got ${appLegacyRedirect.status})`);

	// 3. Security, Tenant Protection & Anti-Enumeration
	console.log("\n[3. app.hookci.com Anti-Enumeration & Access Control]");
	const unauthTenant = await checkUrl(`${APP_HOOKCI_COM}/173773263/runs`);
	assert(unauthTenant.status === 404, `Unauthenticated tenant URL returns 404 anti-enumeration (got ${unauthTenant.status})`);

	const notFound = await checkUrl(`${APP_HOOKCI_COM}/nonexistent-path-for-testing`);
	assert(notFound.status === 404, `Unknown URL returns 404 (got ${notFound.status})`);

	const unauthMcp = await checkUrl(`${APP_HOOKCI_COM}/mcp`, { method: "POST" });
	assert(unauthMcp.status === 401, `Unauthenticated /mcp returns 401 (got ${unauthMcp.status})`);

	const unauthAgentSink = await checkUrl(`${APP_HOOKCI_COM}/v1/agent/sinks`, { method: "POST" });
	assert(unauthAgentSink.status === 401, `Unauthenticated /v1/agent/sinks returns 401 (got ${unauthAgentSink.status})`);

	const emptyPairRedeem = await checkUrl(`${APP_HOOKCI_COM}/v1/pair/redeem`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	assert(emptyPairRedeem.status === 400, `Empty /v1/pair/redeem returns 400 (got ${emptyPairRedeem.status})`);

	// Summary
	console.log("\n=== Summary ===");
	console.log(`Passed: ${passed}`);
	console.log(`Failed: ${failed}`);
	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Execution error:", err);
	process.exit(1);
});
