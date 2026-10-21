// GET /github/oauth/callback: GitHub sends the browser here after an install
// or permissions update (user authorization during install is on), and after
// the dashboard sign-in (/app/login), which uses the same callback because the
// GitHub App's callback URLs are fixed. A code is
// used only under a state of ours; GitHub's own stateless install redirect is
// sent back to user authorization under a fresh state, so a link carrying
// someone else's code cannot sign this browser in as them. Which installations
// the user may act on comes from GET /user/installations, never from the
// installation_id query parameter. The user token lives only for this
// request: never stored, never logged.

import type { Context } from "hono";
import { linkGithubUser } from "../accounts/service";
import { listLiveInstallations } from "../db/installations";
import { hitIpRate } from "../db/ip-rate";
import { type Clock, systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { getUser, listUserInstallations } from "../github/api";
import { GitHubClient } from "../github/client";
import { exchangeCode, redirectToAuthorize } from "../github/oauth";
import { defaultFetcher } from "../http";
import { CLEAR_STATE_COOKIE, consumeAnyState, issueSession, issueState, readAnySession } from "../oauth/state";
import { logEvent } from "../observability";
import { connectConflictPage } from "../pages/account";
import { noInstallationPage } from "../pages/dashboard";
import { errorPage } from "../pages/error";
import { pickerPage, updatedPage } from "../pages/installed";
import { QUOTAS } from "../quotas";
import { isSyncableInstallation, type SyncableInstallation, syncInstallation } from "../webhook/installation";
import { finishInstall } from "./start";

const RATE_WINDOW_MS = 600_000;

interface CallbackQuery {
	code: string | undefined;
	state: string | undefined;
	setupAction: string | undefined;
	installationId: string | undefined;
	cookieHeader: string | null;
}

/**
 * Ends the dashboard sign-in: a session covering the hub's live installations
 * among those the user can access, then the dashboard. Read-only, so unlike an
 * install it syncs nothing from GitHub. For an email account (accountId) the
 * session also names the account, and it is issued even when no live
 * installation is covered, so the person stays signed in to their account.
 */
async function finishDashboardLogin(
	env: Env,
	clock: Clock,
	user: { id: number; login: string },
	accessible: readonly SyncableInstallation[],
	accountId?: string,
): Promise<Response> {
	const live = await listLiveInstallations(env.DB, accessible.map((i) => i.id));
	logEvent("dashboard_login", { github_user_id: user.id, installations: live.length, account: accountId !== undefined });
	if (live.length === 0 && accountId === undefined) return noInstallationPage([CLEAR_STATE_COOKIE]);
	const session = await issueSession(
		env,
		{ installationIds: live.map((i) => i.id), githubUserId: user.id, githubLogin: user.login, ...(accountId === undefined ? {} : { accountId }) },
		clock.now(),
	);
	if (live.length === 0) return noInstallationPage([CLEAR_STATE_COOKIE, session]);
	const headers = new Headers({ Location: "/app", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
	headers.append("Set-Cookie", CLEAR_STATE_COOKIE);
	headers.append("Set-Cookie", session);
	return new Response(null, { status: 303, headers });
}

/**
 * The GitHub step of an email account's sign-in: the state was issued by
 * /account/connect-github for this account, and the browser's session must
 * still name it, so a state cannot be completed by or for another browser.
 * The account is linked to the GitHub user GitHub just authenticated; what that
 * user may see is then the same installation list as any dashboard sign-in.
 */
async function finishAccountLogin(
	env: Env,
	clock: Clock,
	cookieHeader: string | null,
	accountId: string,
	user: { id: number; login: string },
	accessible: readonly SyncableInstallation[],
): Promise<Response> {
	const session = await readAnySession(env, cookieHeader, clock.now());
	if (env.ACCOUNTS_ENABLED !== "true" || session?.accountId !== accountId) throw new HubError("oauth_state_invalid", 400);
	const link = await linkGithubUser(env, accountId, user);
	if (!link.ok) {
		if (link.reason === "unknown_account") throw new HubError("oauth_state_invalid", 400);
		return connectConflictPage({ status: 409, cookies: [CLEAR_STATE_COOKIE] });
	}
	return finishDashboardLogin(env, clock, user, accessible, accountId);
}

async function completeCallback(env: Env, clock: Clock, q: CallbackQuery): Promise<Response> {
	if (q.state === undefined) {
		if (q.setupAction !== "install" && q.setupAction !== "update") throw new HubError("oauth_state_invalid", 400);
		const { state, cookie } = await issueState(env, "github_install", { setup_action: q.setupAction, installation_id: q.installationId }, clock.now());
		return redirectToAuthorize(env, state, "/github/oauth/callback", cookie);
	}
	const { kind, payload } = await consumeAnyState(env, ["github_install", "dashboard_login"], q.state, q.cookieHeader, clock.now());
	const setupAction = typeof payload.setup_action === "string" ? payload.setup_action : q.setupAction;
	const installationId = typeof payload.installation_id === "string" ? payload.installation_id : q.installationId;
	if (!q.code) throw new HubError("github_oauth_failed", 400);

	const fetcher = env.__TEST_FETCHER ?? defaultFetcher;
	const github = new GitHubClient(env, fetcher, () => clock.now());
	const user = github.user((await exchangeCode(env, fetcher, q.code)).access_token);
	const appId = Number(env.GITHUB_APP_ID);
	const accessible: SyncableInstallation[] = [];
	for (const inst of await listUserInstallations(user)) {
		if (inst.app_id === appId && isSyncableInstallation(inst)) accessible.push(inst);
	}
	if (kind === "dashboard_login") {
		const github = await getUser(user);
		const accountId = typeof payload.account_id === "string" ? payload.account_id : undefined;
		return accountId === undefined
			? finishDashboardLogin(env, clock, github, accessible)
			: finishAccountLogin(env, clock, q.cookieHeader, accountId, github, accessible);
	}

	const chosen =
		installationId !== undefined
			? accessible.find((i) => String(i.id) === installationId)
			: accessible.length === 1
				? accessible[0]
				: undefined;
	if (!chosen && (installationId !== undefined || accessible.length === 0)) throw new HubError("github_no_access", 403);
	const { id: githubUserId, login: githubLogin } = await getUser(user);
	const cookies = [CLEAR_STATE_COOKIE];

	if (!chosen) {
		for (const inst of accessible) await syncInstallation(env, github, inst, clock.now());
		const session = await issueSession(env, { installationIds: accessible.map((i) => i.id), githubUserId, githubLogin }, clock.now());
		return pickerPage(
			accessible.map((i) => ({ id: i.id, accountLogin: i.account.login })),
			[...cookies, session],
		);
	}
	await syncInstallation(env, github, chosen, clock.now());
	if (setupAction === "update") return updatedPage(chosen.account.login, cookies);
	return finishInstall(env, github, {
		installation: { id: chosen.id, account_login: chosen.account.login, account_type: chosen.account.type, account_id: chosen.account.id },
		user: { githubUserId, githubLogin },
		accessibleIds: accessible.map((i) => i.id),
		cookies,
		now: clock.now(),
	});
}

export async function githubOAuthCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
	const env = c.env;
	const clock = env.__TEST_CLOCK ?? systemClock;
	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	const rate = await hitIpRate(env.DB, `oauth:${ip}`, QUOTAS.oauthCallbacksPer10MinPerIp, RATE_WINDOW_MS, clock.now());
	if (!rate.ok) return errorPage("rate_limited", 429);
	try {
		return await completeCallback(env, clock, {
			code: c.req.query("code"),
			state: c.req.query("state"),
			setupAction: c.req.query("setup_action"),
			installationId: c.req.query("installation_id"),
			cookieHeader: c.req.header("cookie") ?? null,
		});
	} catch (err) {
		if (err instanceof HubError) return errorPage(err.code, err.status, [CLEAR_STATE_COOKIE]);
		throw err;
	}
}
