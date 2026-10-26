// The dashboard's Agents, Repositories and Settings tabs. Read-only; access is
// decided by scopeOf exactly as for the overview: the session must cover the
// installation, and anything else answers the same 404 page.

import type { Context } from "hono";
import { csrfForForm } from "../accounts/csrf";
import { listApiTokens } from "../db/api-tokens";
import { filterRepositories, REPOSITORY_FILTERS, repositoryItems } from "../dashboard/repositories";
import { getInstallationUsage, listRepositories, listRepositoryBindings, listRepositoryWatches, listSlackLinks, REPOSITORY_LIMIT } from "../db/tabs";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { notFoundPage } from "../pages/dashboard";
import { repositoriesPage } from "../pages/repositories";
import { settingsPage } from "../pages/tabs";
import { dashboardChrome } from "./account";
import { type Scope, scopeOf } from "./dashboard";

type AppContext = Context<{ Bindings: Env }>;

async function viewOf(c: AppContext, scope: Scope) {
	return {
		account: scope.account,
		accounts: scope.accounts,
		login: scope.session.githubLogin,
		now: (c.env.__TEST_CLOCK ?? systemClock).now(),
		latestAgentVersion: c.env.LATEST_AGENT_VERSION,
		...(await dashboardChrome(c, scope.session)),
	};
}

export async function dashboardRepositories(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const { t } = scope;
	const [repos, bindings, watches] = await Promise.all([listRepositories(t), listRepositoryBindings(t), listRepositoryWatches(t)]);
	const query = new URL(c.req.url).searchParams;
	const search = (query.get("q") ?? "").slice(0, 100);
	const filter = REPOSITORY_FILTERS.find((f) => f === query.get("filter")) ?? "all";
	const cut = repos.length > REPOSITORY_LIMIT;
	const all = repositoryItems(cut ? repos.slice(0, REPOSITORY_LIMIT) : repos, bindings, watches);
	return repositoriesPage({ ...(await viewOf(c, scope)), items: filterRepositories(all, search, filter), any: all.length > 0, search, filter, cut });
}

export async function dashboardSettings(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const view = await viewOf(c, scope);
	const [slack, usage, tokens] = await Promise.all([
		listSlackLinks(scope.t),
		getInstallationUsage(scope.t, new Date(view.now).toISOString().slice(0, 10)),
		listApiTokens(scope.t),
	]);
	const { token: csrf, cookie } = await csrfForForm(c.env, c.req.header("cookie") ?? null);
	const cookies = [...(view.cookies ?? []), ...(cookie === null ? [] : [cookie])];
	return settingsPage({ ...view, slack, usage, tokens, csrf, ...(cookies.length > 0 ? { cookies } : {}) });
}
