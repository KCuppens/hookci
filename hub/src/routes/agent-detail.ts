// One agent's page and its two writes. The page is read-only (access is scopeOf's). Revoking the
// agent and unbinding one of its repositories are session writes: same-origin form with a csrf
// token, by an administrator of the GitHub account. The agent is always looked up inside the
// session's installation, so another installation's agent id answers the same 404 as a missing one.

import type { Context } from "hono";
import { csrfForForm, readCheckedForm } from "../accounts/csrf";
import { bindTargetOf } from "../dashboard/repositories";
import { linkedLoginOf, listAgentBindingRows } from "../db/agent-detail";
import { parseBudgetForm } from "../capacity";
import { getAgent, setAgentBudget } from "../db/agents";
import { unbind } from "../db/bindings";
import { listRunsFiltered } from "../db/overview";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { logEvent, reportError } from "../observability";
import { agentDetailPage } from "../pages/agent-detail";
import { pairRefusal } from "../pages/agent-pair";
import { type DashboardChrome, notFoundPage } from "../pages/dashboard";
import { callAgentDo, revokeAgent } from "../pairing/agents";
import { commandGitHub, isInstallationAdmin } from "../slack/resolve";
import { S } from "../strings";
import { dashboardChrome } from "./account";
import { type Scope, scopeOf } from "./dashboard";

type AppContext = Context<{ Bindings: Env }>;

const P = S.agents.pairing;
const RECENT_RUNS = 10;
const REPO_ID = /^[1-9][0-9]{0,15}$/;

/** The csrf token a form on the page carries, and the cookie to set when the session has none. */
async function csrfOf(c: AppContext, chrome: { chrome?: DashboardChrome; cookies?: string[] }) {
	if (chrome.chrome) return { csrf: chrome.chrome.csrf, cookies: chrome.cookies };
	const { token, cookie } = await csrfForForm(c.env, c.req.header("cookie") ?? null);
	return { csrf: token, cookies: cookie === null ? undefined : [cookie] };
}

export async function dashboardAgent(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const agent = await getAgent(scope.t, c.req.param("agentId") ?? "");
	if (!agent) return notFoundPage();
	const chrome = await dashboardChrome(c, scope.session);
	const { csrf, cookies } = await csrfOf(c, chrome);
	const notice = new URL(c.req.url).searchParams.get("notice");
	return agentDetailPage({
		account: scope.account,
		accounts: scope.accounts,
		login: scope.session.githubLogin,
		...(chrome.chrome ? { chrome: chrome.chrome } : {}),
		...(cookies ? { cookies } : {}),
		csrf,
		now: (c.env.__TEST_CLOCK ?? systemClock).now(),
		latestAgentVersion: c.env.LATEST_AGENT_VERSION,
		agent,
		bindings: await listAgentBindingRows(scope.t, agent.agent_id),
		runs: await listRunsFiltered(scope.t, RECENT_RUNS, { agentId: agent.agent_id }),
		pairedBy: await linkedLoginOf(scope.t, agent.paired_by_github_id),
		notice: notice === "revoked" || notice === "unbound" || notice === "budgetSaved" || notice === "budgetReset" ? S.agents.notices[notice] : null,
	});
}

/** The scope and form of an administrator's checked POST, or the response that refuses it. */
async function adminForm(c: AppContext, reason: string): Promise<{ scope: Scope; form: Record<string, string> } | Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const { session, account } = scope;
	const refuse = (message: string, status: number) => pairRefusal(account.id, P.revokeFailTitle, message, status);
	const form = await readCheckedForm(c.env, c.req.raw);
	if (!form) return refuse(P.csrf, 403);
	const user = { githubUserId: session.githubUserId, githubLogin: session.githubLogin };
	if (!(await isInstallationAdmin(c.env, commandGitHub(c.env), account, user, true))) {
		logEvent("tenant_denied", { installation_id: account.id, github_user_id: session.githubUserId, reason });
		return refuse(P.notAdmin, 403);
	}
	return { scope, form };
}

function back(installationId: number, agentId: string, notice: string): Response {
	const location = `/app/${installationId}/agents/${encodeURIComponent(agentId)}?notice=${notice}`;
	return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

export async function revokeAgentForm(c: AppContext): Promise<Response> {
	const checked = await adminForm(c, "agent_revoke_not_admin");
	if (checked instanceof Response) return checked;
	const { scope } = checked;
	const agent = await getAgent(scope.t, c.req.param("agentId") ?? "");
	if (!agent || agent.revoked_at !== null) {
		logEvent("tenant_denied", { installation_id: scope.account.id, github_user_id: scope.session.githubUserId, reason: "agent_not_found" });
		return pairRefusal(scope.account.id, P.revokeFailTitle, P.notFound, 404);
	}
	await revokeAgent(c.env, agent.agent_id, "revoked");
	logEvent("agent_revoke", { installation_id: scope.account.id, actor: scope.session.githubUserId, agent_id: agent.agent_id, via: "dashboard" });
	return back(scope.account.id, agent.agent_id, "revoked");
}

export async function unbindAgentForm(c: AppContext): Promise<Response> {
	const checked = await adminForm(c, "agent_unbind_not_admin");
	if (checked instanceof Response) return checked;
	const { scope, form } = checked;
	const agent = await getAgent(scope.t, c.req.param("agentId") ?? "");
	const raw = form.target ?? "";
	const target = bindTargetOf(raw === "checks" ? "checks" : raw.startsWith("deploy:") ? "deploy" : undefined, raw.slice("deploy:".length));
	const repoId = REPO_ID.test(form.repo_id ?? "") ? Number(form.repo_id) : null;
	if (!agent || target === null || repoId === null || !(await unbind(scope.t, repoId, target, agent.agent_id))) {
		logEvent("tenant_denied", { installation_id: scope.account.id, github_user_id: scope.session.githubUserId, reason: "agent_unbind_not_found" });
		return pairRefusal(scope.account.id, P.revokeFailTitle, P.notFound, 404);
	}
	logEvent("repo_unbind", { installation_id: scope.account.id, actor: scope.session.githubUserId, agent_id: agent.agent_id, repo_id: repoId, target, via: "dashboard" });
	return back(scope.account.id, agent.agent_id, "unbound");
}

/** Sets the agent's budget override from the form, or clears it when the form's action is reset, and pushes it to the agent if connected. */
export async function setAgentBudgetForm(c: AppContext): Promise<Response> {
	const checked = await adminForm(c, "agent_budget_not_admin");
	if (checked instanceof Response) return checked;
	const { scope, form } = checked;
	const agent = await getAgent(scope.t, c.req.param("agentId") ?? "");
	if (!agent || agent.revoked_at !== null) {
		logEvent("tenant_denied", { installation_id: scope.account.id, github_user_id: scope.session.githubUserId, reason: "agent_not_found" });
		return pairRefusal(scope.account.id, P.revokeFailTitle, P.notFound, 404);
	}
	const reset = form.action === "reset";
	const parsed = reset ? { cpus: null, memory_bytes: null } : parseBudgetForm(form.cpus ?? "", form.memory_gib ?? "");
	if (typeof parsed === "string") return pairRefusal(scope.account.id, P.revokeFailTitle, parsed === "cpus" ? P.budgetCpus : P.budgetMemory, 400);
	if (!(await setAgentBudget(scope.t, agent.agent_id, parsed))) return pairRefusal(scope.account.id, P.revokeFailTitle, P.notFound, 404);
	logEvent("agent_budget", { installation_id: scope.account.id, actor: scope.session.githubUserId, agent_id: agent.agent_id, cpus: parsed.cpus ?? "auto", memory_bytes: parsed.memory_bytes ?? "auto" });
	try {
		await callAgentDo(c.env, agent.agent_id, "budget", parsed);
	} catch (err) {
		reportError(err, { agent_id: agent.agent_id, installation_id: scope.account.id, op: "push_budget" });
	}
	return back(scope.account.id, agent.agent_id, reset ? "budgetReset" : "budgetSaved");
}
