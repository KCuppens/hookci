// GET /github/oauth/callback: GitHub sends the browser here after an install
// or permissions update (user authorization during install is on). Which
// installations the user may act on comes from GET /user/installations, never
// from the installation_id query parameter. The user token lives only for
// this request: never stored, never logged.

import type { Context } from "hono";
import { hitIpRate } from "../db/ip-rate";
import { type Clock, systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { getUser, listUserInstallations } from "../github/api";
import { GitHubClient } from "../github/client";
import { exchangeCode } from "../github/oauth";
import { defaultFetcher } from "../http";
import { CLEAR_STATE_COOKIE, consumeState, issueSession, readCookie, STATE_COOKIE } from "../oauth/state";
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

async function completeCallback(env: Env, clock: Clock, q: CallbackQuery): Promise<Response> {
	if (q.state !== undefined) {
		await consumeState(env, "github_install", q.state, q.cookieHeader, clock.now());
	} else if ((q.setupAction !== "install" && q.setupAction !== "update") || readCookie(q.cookieHeader, STATE_COOKIE) !== null) {
		// GitHub's own install and permission-update redirects carry no state of ours; once
		// /start set the state cookie, the state is required.
		throw new HubError("oauth_state_invalid", 400);
	}
	if (!q.code) throw new HubError("github_oauth_failed", 400);

	const fetcher = env.__TEST_FETCHER ?? defaultFetcher;
	const github = new GitHubClient(env, fetcher, () => clock.now());
	const user = github.user((await exchangeCode(env, fetcher, q.code)).access_token);
	const appId = Number(env.GITHUB_APP_ID);
	const accessible: SyncableInstallation[] = [];
	for (const inst of await listUserInstallations(user)) {
		if (inst.app_id === appId && isSyncableInstallation(inst)) accessible.push(inst);
	}
	const chosen =
		q.installationId !== undefined
			? accessible.find((i) => String(i.id) === q.installationId)
			: accessible.length === 1
				? accessible[0]
				: undefined;
	if (!chosen && (q.installationId !== undefined || accessible.length === 0)) throw new HubError("github_no_access", 403);
	const { id: githubUserId } = await getUser(user);
	const cookies = [CLEAR_STATE_COOKIE];

	if (!chosen) {
		for (const inst of accessible) await syncInstallation(env, github, inst, clock.now());
		const session = await issueSession(env, { installationIds: accessible.map((i) => i.id), githubUserId }, clock.now());
		return pickerPage(
			accessible.map((i) => ({ id: i.id, accountLogin: i.account.login })),
			[...cookies, session],
		);
	}
	await syncInstallation(env, github, chosen, clock.now());
	if (q.setupAction === "update") return updatedPage(chosen.account.login, cookies);
	return finishInstall(env, {
		installationId: chosen.id,
		accountLogin: chosen.account.login,
		githubUserId,
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
