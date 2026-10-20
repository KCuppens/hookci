// GET /runs/:runId/logs?job=: the stable log link (logs/links.ts). It answers
// with a redirect to a fresh signed viewer URL: at once for a public repo;
// for a private one once the browser holds a zc_session (auth/session.ts) of a
// GitHub user with a role on the repo. Without a session it sends the browser
// through GitHub's user authorization; GET /auth/github/callback reads who
// that is, discards the user token, sets the session and returns to the link.
// An unknown run or job and a denied user get the same 404.

import type { Context } from "hono";
import { issueSession, readSession } from "../auth/session";
import { hitIpRate } from "../db/ip-rate";
import { getJob, getRunOwner } from "../db/runs";
import { tenantDb } from "../db/tenant";
import { type Clock, systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { deleteUserToken, getUser } from "../github/api";
import { GitHubClient } from "../github/client";
import { exchangeCode, redirectToAuthorize } from "../github/oauth";
import { defaultFetcher } from "../http";
import { isJobName } from "../logs/keys";
import { logAccess } from "../logs/links";
import { signLogUrl } from "../logs/signing";
import { CLEAR_STATE_COOKIE, consumeState, issueState } from "../oauth/state";
import { logEvent, reportError } from "../observability";
import { errorPage } from "../pages/error";
import { QUOTAS } from "../quotas";
import { S } from "../strings";
import { noticePage } from "./log-viewer";

type AppContext = Context<{ Bindings: Env }>;

const RATE_WINDOW_MS = 600_000;

/** Whether returnTo is a stable log link path on this hub, the only place the sign-in returns to. */
export function isLogReturnPath(returnTo: string): boolean {
	return /^\/runs\/[^/?#\\]+\/logs\?job=[^#\\]*$/.test(returnTo);
}

/** Redirect to a signed viewer URL for the job, valid LOG_URL_TTL_SEC. */
async function toViewer(env: Env, installationId: number, runId: string, job: string, now: number): Promise<Response> {
	const url = await signLogUrl(env, { installationId, runId, job }, new Date(now));
	return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export async function logLinks(c: AppContext): Promise<Response> {
	const env = c.env;
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const runId = c.req.param("runId") ?? "";
	const job = c.req.query("job") ?? "";
	const notFound = noticePage(S.logViewer.notFoundTitle, S.logViewer.noLog, 404);

	const owner = isJobName(job) ? await getRunOwner(env.DB, runId) : null;
	if (!owner || !(await getJob(tenantDb(env.DB, owner.installation_id), runId, job))) return notFound;

	const session = await readSession(env, c.req.raw, now);
	const access = await logAccess(env, owner.installation_id, owner.repo_id, session?.login ?? null);
	if (access === "allowed") return toViewer(env, owner.installation_id, runId, job, now);
	if (access === "denied") {
		const who: Record<string, number> = session ? { github_user_id: session.githubUserId } : {};
		logEvent("tenant_denied", { installation_id: owner.installation_id, run_id: runId, job, ...who, reason: "log_access" });
		return notFound;
	}
	const returnTo = `/runs/${encodeURIComponent(runId)}/logs?job=${encodeURIComponent(job)}`;
	const { state, cookie } = await issueState(env, "github_logs", { return_to: returnTo }, now);
	return redirectToAuthorize(env, state, "/auth/github/callback", cookie);
}

async function completeSignIn(env: Env, clock: Clock, code: string | undefined, state: string | undefined, cookieHeader: string | null): Promise<Response> {
	if (state === undefined) throw new HubError("oauth_state_invalid", 400, "logs callback without state");
	const { return_to: returnTo } = await consumeState(env, "github_logs", state, cookieHeader, clock.now());
	if (typeof returnTo !== "string" || !isLogReturnPath(returnTo)) {
		throw new HubError("oauth_state_invalid", 400, "github_logs state lacks a log link to return to");
	}
	if (!code) throw new HubError("github_oauth_failed", 400, "logs callback without code");

	const fetcher = env.__TEST_FETCHER ?? defaultFetcher;
	const github = new GitHubClient(env, fetcher, () => clock.now());
	const userToken = (await exchangeCode(env, fetcher, code)).access_token;
	let session: string;
	try {
		const { id, login } = await getUser(github.user(userToken));
		session = await issueSession(env, { githubUserId: id, login }, clock.now());
	} finally {
		try {
			await deleteUserToken(github.oauthApp(), env.GITHUB_CLIENT_ID, userToken);
		} catch (err) {
			reportError(err, { step: "github_logs_revoke" });
		}
	}
	const headers = new Headers({ Location: `${env.HUB_ORIGIN}${returnTo}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
	headers.append("Set-Cookie", session);
	headers.append("Set-Cookie", CLEAR_STATE_COOKIE);
	return new Response(null, { status: 302, headers });
}

export async function authGithubCallback(c: AppContext): Promise<Response> {
	const env = c.env;
	const clock = env.__TEST_CLOCK ?? systemClock;
	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	if (!(await hitIpRate(env.DB, `github_logs_callback:${ip}`, QUOTAS.oauthCallbacksPer10MinPerIp, RATE_WINDOW_MS, clock.now())).ok) {
		return errorPage("rate_limited", 429);
	}
	try {
		return await completeSignIn(env, clock, c.req.query("code"), c.req.query("state"), c.req.header("cookie") ?? null);
	} catch (err) {
		if (err instanceof HubError) return errorPage(err.code, err.status, [CLEAR_STATE_COOKIE]);
		throw err;
	}
}
