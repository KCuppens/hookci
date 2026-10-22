// The Agents tab and the pair-a-new-agent flow. The list is read-only (access is
// scopeOf's). Creating a pairing token is a session write: same-origin form with
// a csrf token, an administrator of the GitHub account, within the installation's
// agent and token limits. The token is shown once in the response, which is never
// cached, and is not logged.

import type { Context } from "hono";
import { csrfForForm, readCheckedForm } from "../accounts/csrf";
import { countAgentsPairedSince } from "../db/agent-detail";
import { countActiveAgents, getAgent, listAgents } from "../db/agents";
import { listAgentsWithRuns } from "../db/tabs";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { logEvent } from "../observability";
import { pairPage, pairRefusal } from "../pages/agent-pair";
import { agentsPage } from "../pages/agents";
import { type DashboardChrome, notFoundPage } from "../pages/dashboard";
import { createPairToken } from "../pairing/tokens";
import { QUOTAS } from "../quotas";
import { commandGitHub, isInstallationAdmin } from "../slack/resolve";
import { S } from "../strings";
import { dashboardChrome } from "./account";
import { scopeOf } from "./dashboard";

type AppContext = Context<{ Bindings: Env }>;

const P = S.agents.pairing;

/** The csrf token a form on the page carries, and the cookie to set when the session has none. */
async function csrfOf(c: AppContext, chrome: { chrome?: DashboardChrome; cookies?: string[] }) {
	if (chrome.chrome) return { csrf: chrome.chrome.csrf, cookies: chrome.cookies };
	const { token, cookie } = await csrfForForm(c.env, c.req.header("cookie") ?? null);
	return { csrf: token, cookies: cookie === null ? undefined : [cookie] };
}

export async function dashboardAgents(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const chrome = await dashboardChrome(c, scope.session);
	const { csrf, cookies } = await csrfOf(c, chrome);
	const notice = new URL(c.req.url).searchParams.get("notice");
	return agentsPage({
		account: scope.account,
		accounts: scope.accounts,
		login: scope.session.githubLogin,
		...(chrome.chrome ? { chrome: chrome.chrome } : {}),
		...(cookies ? { cookies } : {}),
		csrf,
		now: (c.env.__TEST_CLOCK ?? systemClock).now(),
		hubOrigin: c.env.HUB_ORIGIN,
		latestAgentVersion: c.env.LATEST_AGENT_VERSION,
		agents: await listAgentsWithRuns(scope.t),
		limit: QUOTAS.agentsPerInstallation,
		notice: notice === "revoked" || notice === "unbound" ? S.agents.notices[notice] : null,
	});
}

export async function pairAgent(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const { session, t, account } = scope;
	const refuse = (message: string, status: number) => pairRefusal(account.id, P.failTitle, message, status);
	const form = await readCheckedForm(c.env, c.req.raw);
	if (!form) return refuse(P.csrf, 403);
	const user = { githubUserId: session.githubUserId, githubLogin: session.githubLogin };
	if (!(await isInstallationAdmin(c.env, commandGitHub(c.env), account, user, true))) {
		logEvent("tenant_denied", { installation_id: account.id, github_user_id: session.githubUserId, reason: "agent_pair_not_admin" });
		return refuse(P.notAdmin, 403);
	}
	const replaceId = form.replace ?? "";
	const target = replaceId === "" ? null : await getAgent(t, replaceId);
	if (replaceId !== "" && (target === null || target.revoked_at !== null)) {
		logEvent("tenant_denied", { installation_id: account.id, github_user_id: session.githubUserId, reason: "agent_not_found" });
		return refuse(P.notFound, 404);
	}
	if (target === null && (await countActiveAgents(t)) >= QUOTAS.agentsPerInstallation) return refuse(P.limit(QUOTAS.agentsPerInstallation), 409);
	let pair: { token: string; expiresAt: number };
	try {
		pair = await createPairToken(c.env, { installationId: account.id, createdByGithubId: session.githubUserId, ...(target ? { replacesAgentId: target.agent_id } : {}) });
	} catch (err) {
		if (err instanceof HubError && err.code === "pair_rate_limited") return refuse(P.rateLimited(QUOTAS.pairTokensPerHour), 429);
		throw err;
	}
	logEvent("agent_pair_token", { installation_id: account.id, actor: session.githubUserId, replaces: target?.agent_id ?? "", via: "dashboard" });
	const chrome = await dashboardChrome(c, session);
	return pairPage({
		account,
		accounts: scope.accounts,
		login: session.githubLogin,
		...(chrome.chrome ? { chrome: chrome.chrome } : {}),
		...(chrome.cookies ? { cookies: chrome.cookies } : {}),
		csrf: form.csrf ?? "",
		now: (c.env.__TEST_CLOCK ?? systemClock).now(),
		hubOrigin: c.env.HUB_ORIGIN,
		token: pair.token,
		expiresAt: pair.expiresAt,
		perHour: QUOTAS.pairTokensPerHour,
		replaceable: (await listAgents(t)).filter((a) => a.revoked_at === null),
		replacing: target?.agent_id ?? null,
	});
}

/** Whether an agent paired since the page's token was issued: the pair page polls this. */
export async function pairStatus(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const after = Number(new URL(c.req.url).searchParams.get("after"));
	const paired = Number.isSafeInteger(after) && after > 0 && (await countAgentsPairedSince(scope.t, after)) > 0;
	return Response.json({ paired }, { headers: { "cache-control": "no-store" } });
}
