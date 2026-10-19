// GET /github/link/start and GET /github/link/callback: the browser half of
// /zeroci me. Start binds the browser to the state from the Slack button and
// sends it to GitHub's user authorization; the callback records which GitHub
// user that is for the Slack user in the state, then revokes the user token.
// The token lives only for this request: never stored, never logged.

import type { Context } from "hono";
import { hitIpRate } from "../db/ip-rate";
import { upsertUserLink } from "../db/workspaces";
import { type Clock, systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { deleteUserToken, getUser } from "../github/api";
import { GitHubClient } from "../github/client";
import { exchangeCode } from "../github/oauth";
import { defaultFetcher } from "../http";
import { CLEAR_STATE_COOKIE, checkState, consumeState } from "../oauth/state";
import { logEvent, reportError } from "../observability";
import { errorPage } from "../pages/error";
import { linkedPage } from "../pages/linked";
import { QUOTAS } from "../quotas";

type AppContext = Context<{ Bindings: Env }>;

const RATE_WINDOW_MS = 600_000;

/** Counts one hit of the route against the caller's IP; false once the IP is over the limit. */
async function underIpLimit(c: AppContext, route: string, now: number): Promise<boolean> {
	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	return (await hitIpRate(c.env.DB, `${route}:${ip}`, QUOTAS.oauthCallbacksPer10MinPerIp, RATE_WINDOW_MS, now)).ok;
}

export async function githubLinkStart(c: AppContext): Promise<Response> {
	const env = c.env;
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	if (!(await underIpLimit(c, "github_link_start", now))) return errorPage("rate_limited", 429);
	const state = c.req.query("t");
	let cookie: string;
	try {
		if (state === undefined) throw new HubError("oauth_state_invalid", 400, "link start without t");
		cookie = await checkState(env, "github_link", state, now);
	} catch (err) {
		if (err instanceof HubError) return errorPage(err.code, err.status);
		throw err;
	}
	const authorize = new URL("https://github.com/login/oauth/authorize");
	authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	authorize.searchParams.set("state", state);
	authorize.searchParams.set("redirect_uri", `${env.HUB_ORIGIN}/github/link/callback`);
	return new Response(null, {
		status: 302,
		headers: { Location: authorize.toString(), "Set-Cookie": cookie, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
	});
}

/** Revokes the user token; a failure is reported, not shown, since the link is already stored. */
async function discardUserToken(env: Env, github: GitHubClient, userToken: string, teamId: string): Promise<void> {
	try {
		await deleteUserToken(github.oauthApp(), env.GITHUB_CLIENT_ID, userToken);
	} catch (err) {
		reportError(err, { team_id: teamId, step: "github_link_revoke" });
	}
}

async function completeLink(env: Env, clock: Clock, code: string | undefined, state: string | undefined, cookieHeader: string | null): Promise<Response> {
	if (state === undefined) throw new HubError("oauth_state_invalid", 400, "link callback without state");
	const { team_id: teamId, slack_user_id: slackUserId } = await consumeState(env, "github_link", state, cookieHeader, clock.now());
	if (typeof teamId !== "string" || typeof slackUserId !== "string") {
		throw new HubError("oauth_state_invalid", 400, "github_link state lacks the Slack team or user");
	}
	if (!code) throw new HubError("github_oauth_failed", 400, "link callback without code");

	const fetcher = env.__TEST_FETCHER ?? defaultFetcher;
	const github = new GitHubClient(env, fetcher, () => clock.now());
	const userToken = (await exchangeCode(env, fetcher, code)).access_token;
	let login: string;
	try {
		const { id: githubUserId, login: githubLogin } = await getUser(github.user(userToken));
		await upsertUserLink(env.DB, {
			team_id: teamId,
			slack_user_id: slackUserId,
			github_user_id: githubUserId,
			github_login: githubLogin,
			created_at: clock.now(),
		});
		logEvent("github_link", { team_id: teamId, github_user_id: githubUserId });
		login = githubLogin;
	} finally {
		await discardUserToken(env, github, userToken, teamId);
	}
	return linkedPage(login, [CLEAR_STATE_COOKIE]);
}

export async function githubLinkCallback(c: AppContext): Promise<Response> {
	const env = c.env;
	const clock = env.__TEST_CLOCK ?? systemClock;
	if (!(await underIpLimit(c, "github_link_callback", clock.now()))) return errorPage("rate_limited", 429);
	try {
		return await completeLink(env, clock, c.req.query("code"), c.req.query("state"), c.req.header("cookie") ?? null);
	} catch (err) {
		if (err instanceof HubError) return errorPage(err.code, err.status, [CLEAR_STATE_COOKIE]);
		throw err;
	}
}
