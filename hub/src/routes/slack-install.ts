// GET /slack/install and GET /slack/oauth/callback: add the Slack bot to a
// workspace and link it to a GitHub installation. Only a browser holding a
// session from the GitHub install of that installation, for an admin of its
// account, may start; the state carries who that was, so the callback links
// the Slack user who approved the install to that GitHub user.

import type { Context } from "hono";
import { getInstallation } from "../db/installations";
import { hitIpRate } from "../db/ip-rate";
import { tenantDb } from "../db/tenant";
import { linkWorkspace, upsertUserLink } from "../db/workspaces";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { defaultFetcher } from "../http";
import { CLEAR_STATE_COOKIE, consumeState, issueState, readSession } from "../oauth/state";
import { logEvent, reportError } from "../observability";
import { errorPage } from "../pages/error";
import { slackGridUnsupportedPage, slackInstalledPage, slackStartFromGitHubPage } from "../pages/slack-installed";
import { QUOTAS } from "../quotas";
import { commandGitHub, isInstallationAdmin } from "../slack/resolve";
import { exchangeSlackCode, grantedScopesMatch, revokeSlackToken, slackAuthorizeUrl } from "../slack/oauth";
import { storeWorkspace } from "../slack/tokens";
import { installationIdParam } from "./start";

type AppContext = Context<{ Bindings: Env }>;

const RATE_WINDOW_MS = 600_000;

/**
 * Redirects to Slack's consent page, or shows the start-from-GitHub page when
 * the browser has no session for the installation. Only an admin of the
 * installation's account may link it to a workspace.
 */
export async function slackInstall(c: AppContext): Promise<Response> {
	const env = c.env;
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const installationId = installationIdParam(c);
	if (installationId === null) return slackStartFromGitHubPage();
	const session = await readSession(env, c.req.header("cookie"), installationId, now);
	const installation = session ? await getInstallation(env.DB, installationId) : null;
	if (!session || !installation || installation.deleted_at !== null) return slackStartFromGitHubPage();
	try {
		if (!(await isInstallationAdmin(env, commandGitHub(env), installation, session, true))) {
			return errorPage("installation_admin_required", 403);
		}
	} catch (err) {
		if (err instanceof HubError) return errorPage(err.code, err.status);
		throw err;
	}
	const { state, cookie } = await issueState(
		env,
		"slack_install",
		{ installation_id: installationId, github_user_id: session.githubUserId, github_login: session.githubLogin },
		now,
	);
	return new Response(null, {
		status: 302,
		headers: { Location: slackAuthorizeUrl(env, state), "Set-Cookie": cookie, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
	});
}

async function completeCallback(env: Env, now: number, code: string | undefined, state: string | undefined, cookieHeader: string | null): Promise<Response> {
	if (state === undefined) throw new HubError("oauth_state_invalid", 400, "Slack callback without state");
	const payload = await consumeState(env, "slack_install", state, cookieHeader, now);
	const { installation_id: installationId, github_user_id: githubUserId, github_login: githubLogin } = payload;
	if (typeof installationId !== "number" || typeof githubUserId !== "number" || typeof githubLogin !== "string") {
		throw new HubError("oauth_state_invalid", 400, "slack_install state lacks the installation or GitHub user");
	}
	if (!code) throw new HubError("slack_oauth_failed", 400, "Slack callback without code");

	const fetcher = env.__TEST_FETCHER ?? defaultFetcher;
	const result = await exchangeSlackCode(env, fetcher, code);
	if (result.isEnterpriseInstall || result.enterpriseId !== null) {
		const ctx = { enterprise_id: result.enterpriseId ?? "", team_id: result.teamId, installation_id: installationId };
		try {
			await revokeSlackToken(fetcher, result.botToken);
		} catch (err) {
			reportError(err, ctx);
		}
		logEvent("slack_install_grid_refused", ctx);
		return slackGridUnsupportedPage([CLEAR_STATE_COOKIE]);
	}
	if (!grantedScopesMatch(result.scope)) {
		throw new HubError("slack_scope_mismatch", 400, `Slack granted scopes "${result.scope}"`);
	}

	await storeWorkspace(env, result, result.authedUserId);
	await linkWorkspace(tenantDb(env.DB, installationId), result.teamId, result.authedUserId, now);
	await upsertUserLink(env.DB, {
		team_id: result.teamId,
		slack_user_id: result.authedUserId,
		github_user_id: githubUserId,
		github_login: githubLogin,
		created_at: now,
	});
	logEvent("slack_install", { team_id: result.teamId, installation_id: installationId });
	return slackInstalledPage({ teamId: result.teamId, teamName: result.teamName, slackAppId: env.SLACK_APP_ID, cookies: [CLEAR_STATE_COOKIE] });
}

export async function slackOAuthCallback(c: AppContext): Promise<Response> {
	const env = c.env;
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	const rate = await hitIpRate(env.DB, `slack_oauth:${ip}`, QUOTAS.oauthCallbacksPer10MinPerIp, RATE_WINDOW_MS, now);
	if (!rate.ok) return errorPage("rate_limited", 429);
	try {
		return await completeCallback(env, now, c.req.query("code"), c.req.query("state"), c.req.header("cookie") ?? null);
	} catch (err) {
		if (err instanceof HubError) return errorPage(err.code, err.status, [CLEAR_STATE_COOKIE]);
		throw err;
	}
}
