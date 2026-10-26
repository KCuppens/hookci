// What the Repositories tab shows per repository (the checks agent, the deploy
// bindings, the Slack channels, the last run), the search and filter on the
// list, and the pieces of the bind form. The POST route is in
// routes/repository-bind.ts.

import { type BindingTarget, deployEnv } from "../db/bindings";
import type { RepositoryBindingRow, RepositoryListRow, RepositoryWatchRow } from "../db/tabs";
import { S } from "../strings";

export const REPOSITORY_FILTERS = ["all", "noAgent", "agentDown", "slack", "failed", "noRuns"] as const;

export type RepositoryFilter = (typeof REPOSITORY_FILTERS)[number];

export interface RepositoryItem extends RepositoryListRow {
	/** The agent bound to the `checks` target, if any. */
	checks: RepositoryBindingRow | null;
	/** The `deploy:<env>` bindings in environment order. */
	deploys: RepositoryBindingRow[];
	watches: RepositoryWatchRow[];
}

export type BindNotice = keyof typeof S.dashboard.reposPage.bindPage.notices;

/** Where an environment sits in a repository's deploy list: staging, then production, then anything else. */
const ENV_RANK: Record<string, number> = { staging: 0, production: 1 };

function envRank(target: BindingTarget): number {
	const env = deployEnv(target) ?? target;
	return Object.hasOwn(ENV_RANK, env) ? (ENV_RANK[env] ?? 2) : 2;
}

/** Each repository with its bindings and watches; the query results are grouped by repo id once. */
export function repositoryItems(repos: readonly RepositoryListRow[], bindings: readonly RepositoryBindingRow[], watches: readonly RepositoryWatchRow[]): RepositoryItem[] {
	const items = new Map<number, RepositoryItem>();
	for (const r of repos) items.set(r.repo_id, { ...r, checks: null, deploys: [], watches: [] });
	for (const b of bindings) {
		const item = items.get(b.repo_id);
		if (!item) continue;
		if (b.target === "checks") item.checks = b;
		else item.deploys.push(b);
	}
	for (const item of items.values()) item.deploys.sort((a, b) => envRank(a.target) - envRank(b.target) || a.target.localeCompare(b.target));
	for (const w of watches) items.get(w.repo_id)?.watches.push(w);
	return [...items.values()];
}

const FILTERS: Record<RepositoryFilter, (r: RepositoryItem) => boolean> = {
	all: () => true,
	noAgent: (r) => r.checks === null,
	agentDown: (r) => r.checks !== null && r.checks.agent_status !== "online",
	slack: (r) => r.watches.some((w) => w.status === "broken"),
	failed: (r) => r.last_state === "failed",
	noRuns: (r) => r.run_count === 0,
};

/** The repositories whose name contains the search text (any case) and that pass the filter. */
export function filterRepositories(items: readonly RepositoryItem[], search: string, filter: RepositoryFilter): RepositoryItem[] {
	const needle = search.trim().toLowerCase();
	return items.filter((r) => FILTERS[filter](r) && (needle === "" || (r.full_name ?? "").toLowerCase().includes(needle)));
}

/** The page path with the search and filter in its query string; defaults are left out. */
export function repositoriesPath(installationId: number, search: string, filter: RepositoryFilter): string {
	const query = new URLSearchParams();
	if (search !== "") query.set("q", search);
	if (filter !== "all") query.set("filter", filter);
	const qs = query.toString();
	return `/${installationId}/repositories${qs === "" ? "" : `?${qs}`}`;
}

export function bindPath(installationId: number): string {
	return `/${installationId}/repositories/bind`;
}

/** The notice text for the request's `?notice=` value, or null when it is absent or not one of ours. */
export function bindNoticeText(url: string): string | null {
	const key = new URL(url).searchParams.get("notice");
	const notices: Record<string, string> = S.dashboard.reposPage.bindPage.notices;
	return key !== null && Object.hasOwn(notices, key) ? (notices[key] ?? null) : null;
}

/** The binding target the form asks for: `checks`, or `deploy:<env>` for a well formed environment name; null for anything else. */
export function bindTargetOf(kind: string | undefined, env: string | undefined): BindingTarget | null {
	if (kind === "checks") return "checks";
	return kind === "deploy" && env !== undefined && /^[a-z0-9_-]+$/i.test(env) ? `deploy:${env}` : null;
}
