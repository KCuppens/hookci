// GET and POST /:installationId/repositories/bind: the form behind the
// Repositories tab's "Bind repositories" button. Access is the tab's (the
// session covers the installation) plus what `/hookci bind` asks for: admin
// access to every selected repository on GitHub. The form carries a csrf
// token and must come from the hub's own origin.

import type { Context } from "hono";
import { csrfForForm, readCheckedForm } from "../accounts/csrf";
import { bindNoticeText, bindPath, bindTargetOf } from "../dashboard/repositories";
import { listAgents } from "../db/agents";
import { bind } from "../db/bindings";
import { getRepo, listRepos } from "../db/repos";
import type { Env } from "../env";
import { HubError } from "../errors";
import { logEvent } from "../observability";
import { notFoundPage } from "../pages/dashboard";
import { escapeHtml, page } from "../pages/layout";
import { bindPage } from "../pages/repositories";
import { commandGitHub, requirePermission } from "../slack/resolve";
import { S } from "../strings";
import { dashboardChrome } from "./account";
import { scopeOf } from "./dashboard";

type AppContext = Context<{ Bindings: Env }>;

const B = S.dashboard.reposPage.bindPage;

/** The most repositories one submission binds: each needs a GitHub permission lookup. */
const MAX_REPOS = 25;

function refuse(installationId: number, message: string, status: number): Response {
	const back = bindPath(installationId);
	return page(B.failTitle, `<p>${escapeHtml(message)}</p>\n<p><a href="${escapeHtml(back)}">${escapeHtml(B.back)}</a></p>`, { status });
}

export async function bindForm(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const { t } = scope;
	const chrome = await dashboardChrome(c, scope.session);
	const { token, cookie } = chrome.chrome ? { token: chrome.chrome.csrf, cookie: null } : await csrfForForm(c.env, c.req.header("cookie") ?? null);
	const picked = new URL(c.req.url).searchParams.getAll("repo");
	return bindPage({
		account: scope.account,
		accounts: scope.accounts,
		login: scope.session.githubLogin,
		...chrome,
		cookies: chrome.cookies ?? (cookie === null ? [] : [cookie]),
		csrf: token,
		repos: await listRepos(t),
		agents: (await listAgents(t)).filter((a) => a.revoked_at === null),
		selected: new Set(picked.map(Number)),
		notice: bindNoticeText(c.req.url),
	});
}

export async function bindSubmit(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const { session, t } = scope;
	const installationId = scope.account.id;
	const form = await readCheckedForm(c.env, c.req.raw);
	if (!form) return refuse(installationId, B.csrf, 403);
	const ids = Object.keys(form)
		.map((key) => /^r(\d{1,15})$/.exec(key)?.[1])
		.filter((id): id is string => id !== undefined)
		.map(Number);
	if (ids.length === 0) return refuse(installationId, B.none, 400);
	if (ids.length > MAX_REPOS) return refuse(installationId, B.tooMany(MAX_REPOS), 400);
	const target = bindTargetOf(form.kind, form.env);
	if (target === null) return refuse(installationId, B.badTarget, 400);
	const agentId = form.agent_id ?? "";
	if (!(await listAgents(t)).some((a) => a.agent_id === agentId && a.revoked_at === null)) return refuse(installationId, B.badAgent, 400);
	const repos = await Promise.all(ids.map((id) => getRepo(t, id)));
	const gh = commandGitHub(c.env);
	for (const repo of repos) {
		if (!repo) return refuse(installationId, B.badRepo, 404);
		try {
			await requirePermission(c.env, gh, installationId, repo.full_name, session.githubLogin, "admin");
		} catch (err) {
			if (!(err instanceof HubError && err.code === "forbidden")) throw err;
			logEvent("tenant_denied", { installation_id: installationId, github_user_id: session.githubUserId, repo_id: repo.repo_id, reason: "repo_bind_not_admin" });
			return refuse(installationId, B.notAdmin(repo.full_name), 403);
		}
	}
	for (const repo of repos) {
		if (!repo) continue;
		await bind(t, repo.repo_id, target, agentId);
		logEvent("repo_bind", { installation_id: installationId, repo_id: repo.repo_id, target, agent_id: agentId, actor: session.githubUserId, via: "dashboard" });
	}
	return new Response(null, { status: 303, headers: { location: `${bindPath(installationId)}?notice=bound`, "cache-control": "no-store" } });
}
