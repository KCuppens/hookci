// GET /start: the onboarding landing page, or the end of the install for an
// installation picked on the picker page. GET /start/status: what the success
// page polls until an agent connects.

import type { Context } from "hono";
import { getInstallation } from "../db/installations";
import { tenantDb } from "../db/tenant";
import { type Clock, systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { issueSession, issueState, readSession } from "../oauth/state";
import { logEvent } from "../observability";
import { errorPage } from "../pages/error";
import { installedPage } from "../pages/installed";
import { startPage } from "../pages/start";
import { createPairToken, PAIR_TOKEN_TTL_MS } from "../pairing/tokens";

type AppContext = Context<{ Bindings: Env }>;

/** The installation_id query parameter when it is a positive integer, else null. */
function installationIdParam(c: AppContext): number | null {
	const raw = c.req.query("installation_id") ?? "";
	return /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;
}

export interface FinishInstall {
	installationId: number;
	accountLogin: string;
	githubUserId: number;
	/** Every installation the user can access; the new session covers them all. */
	accessibleIds: number[];
	/** Set-Cookie values to send besides the session. */
	cookies: string[];
	now: number;
}

/** Mints the pair token for the installation and renders the success page with a fresh session cookie. */
export async function finishInstall(env: Env, f: FinishInstall): Promise<Response> {
	const { token } = await createPairToken(env, { installationId: f.installationId, createdByGithubId: f.githubUserId });
	const session = await issueSession(env, { installationIds: f.accessibleIds, githubUserId: f.githubUserId }, f.now);
	logEvent("github_install", { installation_id: f.installationId, github_user_id: f.githubUserId });
	return installedPage({
		installationId: f.installationId,
		accountLogin: f.accountLogin,
		pairToken: token,
		hubOrigin: env.HUB_ORIGIN,
		expiresInMinutes: PAIR_TOKEN_TTL_MS / 60_000,
		cookies: [...f.cookies, session],
	});
}

async function finishPicked(env: Env, clock: Clock, installationId: number, cookieHeader: string | undefined): Promise<Response> {
	const now = clock.now();
	const session = await readSession(env, cookieHeader, installationId, now);
	const installation = session ? await getInstallation(env.DB, installationId) : null;
	if (!session || !installation || installation.deleted_at !== null) return errorPage("github_no_access", 403);
	try {
		return await finishInstall(env, {
			installationId,
			accountLogin: installation.account_login,
			githubUserId: session.githubUserId,
			accessibleIds: session.installationIds,
			cookies: [],
			now,
		});
	} catch (err) {
		if (err instanceof HubError) return errorPage(err.code, err.status);
		throw err;
	}
}

export async function start(c: AppContext): Promise<Response> {
	const env = c.env;
	const clock = env.__TEST_CLOCK ?? systemClock;
	if (c.req.query("installation_id") !== undefined) {
		const installationId = installationIdParam(c);
		if (installationId === null) return errorPage("github_no_access", 403);
		return finishPicked(env, clock, installationId, c.req.header("cookie"));
	}
	const { state, cookie } = await issueState(env, "github_install", {}, clock.now());
	const installUrl = `https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new?state=${encodeURIComponent(state)}`;
	return startPage(installUrl, cookie);
}

/** JSON status for the browser whose session covers the installation; 404 for anyone else. */
export async function startStatus(c: AppContext): Promise<Response> {
	const env = c.env;
	const installationId = installationIdParam(c);
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	if (installationId === null || !(await readSession(env, c.req.header("cookie"), installationId, now))) {
		return c.json({ error: "not_found" }, 404);
	}
	const installation = await getInstallation(env.DB, installationId);
	const t = tenantDb(env.DB, installationId);
	const agents = await t.first<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE installation_id = ?1 AND status = 'online'");
	const slack = await t.first<{ n: number }>("SELECT COUNT(*) AS n FROM workspace_links WHERE installation_id = ?1");
	return c.json(
		{
			installed: installation !== null && installation.deleted_at === null,
			agents_online: agents?.n ?? 0,
			slack_linked: (slack?.n ?? 0) > 0,
		},
		200,
		{ "Cache-Control": "no-store" },
	);
}
