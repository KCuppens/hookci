// The read-only dashboard: GET /, /login, /:installationId, its
// runs and their logs. The session cookie says which installations the user
// can see; anything it does not cover answers the same 404 page as a page that
// does not exist, so ids cannot be probed. Every lookup is scoped to the
// installation in the session, and a log's R2 key comes from the stored job
// row, never from the URL.

import type { Context } from "hono";
import { runActionsView } from "../dashboard/run-actions";
import { listAgents } from "../db/agents";
import { listRunAnnotations } from "../db/annotations";
import { type InstallationRow, listLiveInstallations } from "../db/installations";
import { hitIpRate } from "../db/ip-rate";
import {
	countRunsAfter,
	countRunsFiltered,
	getOverview,
	listRunAgents,
	listRunAuthors,
	listRunBranches,
	listRunEvents,
	listRunRepos,
	listRunsFiltered,
	newestRunRowid,
	type RunFilter,
} from "../db/overview";
import { getNextAttempt, getRunListRow, listJobsOfRun, type RunListRow } from "../db/runs";
import { type TenantDb, tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { getCommitChanges } from "../github/api";
import { GitHubApiError, GitHubClient } from "../github/client";
import { redirectToAuthorize } from "../github/oauth";
import type { CommitChanges } from "../github/types";
import { defaultFetcher } from "../http";
import { issueState, readAnySession, type Session } from "../oauth/state";
import { logEvent, reportError } from "../observability";
import { noInstallationPage, notFoundPage, signInPage } from "../pages/dashboard";
import { errorPage } from "../pages/error";
import { type OverviewRange, overviewPage } from "../pages/overview";
import { runPage } from "../pages/run-detail";
import { type RunsFilters, runsListPage } from "../pages/runs";
import { QUOTAS } from "../quotas";
import { S } from "../strings";
import { accountsEnabled, dashboardChrome, renderLogin } from "./account";

type AppContext = Context<{ Bindings: Env }>;

const RATE_WINDOW_MS = 600_000;
const ID = /^[1-9][0-9]{0,15}$/;
const HEX = /^[0-9a-f]{1,40}$/;
const AUTHOR = /^[A-Za-z0-9._[\]-]{1,64}$/;
const AGENT = /^[A-Za-z0-9._-]{1,64}$/;
const EVENT = /^[a-z_]{1,32}$/;
const PAGE = /^[1-9][0-9]{0,4}$/;
const ROWID = /^[0-9]{1,16}$/;
const MAX_BRANCH = 255;
const RECENT_RUNS = 6;
const DAY_MS = 86_400_000;

/** What a session covering the installation in the URL has to work with. */
export interface Scope {
	session: Session;
	account: InstallationRow;
	/** Every live installation the session covers, for the account switcher. */
	accounts: InstallationRow[];
	t: TenantDb;
}

/** The scope of :installationId, or null when the session is missing, expired, forged, or does not cover a live installation of that id. */
export async function scopeOf(c: AppContext): Promise<Scope | null> {
	const raw = c.req.param("installationId") ?? "";
	if (!ID.test(raw)) return null;
	const id = Number(raw);
	const session = await readAnySession(c.env, c.req.header("cookie"), (c.env.__TEST_CLOCK ?? systemClock).now());
	if (!session) return null;
	if (!session.installationIds.includes(id)) {
		logEvent("tenant_denied", { installation_id: id, github_user_id: session.githubUserId, reason: "dashboard_not_in_session" });
		return null;
	}
	const accounts = await listLiveInstallations(c.env.DB, session.installationIds);
	const account = accounts.find((a) => a.id === id);
	return account ? { session, account, accounts, t: tenantDb(c.env.DB, id) } : null;
}

export async function dashboardHome(c: AppContext): Promise<Response> {
	const session = await readAnySession(c.env, c.req.header("cookie"), (c.env.__TEST_CLOCK ?? systemClock).now());
	if (!session) return accountsEnabled(c.env) ? renderLogin(c) : signInPage();
	const live = new Set((await listLiveInstallations(c.env.DB, session.installationIds)).map((a) => a.id));
	const first = session.installationIds.find((id) => live.has(id));
	if (first === undefined) {
		// An email account that has not completed GitHub authorization in this session has no installations yet.
		if (session.accountId !== undefined && session.githubUserId === 0) {
			return new Response(null, { status: 303, headers: { Location: "/account/connect-github", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
		}
		const { chrome, cookies } = await dashboardChrome(c, session);
		return noInstallationPage(cookies, chrome);
	}
	return new Response(null, { status: 303, headers: { Location: `/${first}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export async function dashboardLogin(c: AppContext): Promise<Response> {
	const env = c.env;
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	if (!(await hitIpRate(env.DB, `dashboard_login:${ip}`, QUOTAS.oauthCallbacksPer10MinPerIp, RATE_WINDOW_MS, now)).ok) {
		return errorPage("rate_limited", 429);
	}
	const { state, cookie } = await issueState(env, "dashboard_login", {}, now);
	return redirectToAuthorize(env, state, "/github/oauth/callback", cookie);
}

export async function dashboardOverview(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const now = (c.env.__TEST_CLOCK ?? systemClock).now();
	const asked = c.req.query("range");
	const range: OverviewRange = asked === "week" || asked === "month" ? asked : "today";
	// The UTC day so far, or the last 7 or 30 days.
	const since = range === "today" ? now - (now % DAY_MS) : now - (range === "week" ? 7 : 30) * DAY_MS;
	const [overview, runs, allAgents] = await Promise.all([
		getOverview(scope.t, now),
		listRunsFiltered(scope.t, RECENT_RUNS, { since }),
		listAgents(scope.t),
	]);
	const agents = allAgents.filter((a) => a.status !== "revoked");
	return overviewPage({
		account: scope.account,
		accounts: scope.accounts,
		login: scope.session.githubLogin,
		now,
		range,
		overview,
		runs,
		agents,
		latestAgentVersion: c.env.LATEST_AGENT_VERSION,
		...(await dashboardChrome(c, scope.session)),
	});
}

/** The run list's filters as the page echoes them back: only values the filters accept survive, anything else is dropped. */
function filtersOf(c: AppContext): RunsFilters {
	const q = (name: string): string => c.req.query(name) ?? "";
	const repo = q("repo");
	const branch = q("branch");
	const sha = q("sha").toLowerCase();
	const author = q("author");
	const agent = q("agent");
	const event = q("event");
	const state = q("state");
	return {
		state: Object.hasOwn(S.dashboard.list.states, state) ? state : "",
		repo: ID.test(repo) ? repo : "",
		branch: branch.length <= MAX_BRANCH ? branch : "",
		sha: HEX.test(sha) ? sha : "",
		author: AUTHOR.test(author) ? author : "",
		agent: AGENT.test(agent) ? agent : "",
		event: EVENT.test(event) ? event : "",
		sort: q("sort") === "oldest" ? "oldest" : "newest",
	};
}

function runFilterOf(filters: RunsFilters): RunFilter {
	const filter: RunFilter = {};
	if (filters.state !== "") filter.state = filters.state;
	if (filters.repo !== "") filter.repoId = Number(filters.repo);
	if (filters.branch !== "") filter.branch = filters.branch;
	if (filters.sha !== "") filter.sha = filters.sha;
	if (filters.author !== "") filter.author = filters.author;
	if (filters.agent !== "") filter.agentId = filters.agent;
	if (filters.event !== "") filter.event = filters.event;
	if (filters.sort === "oldest") filter.oldestFirst = true;
	return filter;
}

export async function dashboardRunsList(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const now = (c.env.__TEST_CLOCK ?? systemClock).now();
	const filters = filtersOf(c);
	const filter = runFilterOf(filters);
	const perPage = QUOTAS.dashboardRunsPerPage;
	const wanted = c.req.query("page") ?? "";
	const page = PAGE.test(wanted) ? Number(wanted) : 1;
	const t = scope.t;
	const [runs, total, newest, repos, branches, authors, agents, events] = await Promise.all([
		listRunsFiltered(t, perPage, filter, (page - 1) * perPage),
		countRunsFiltered(t, filter),
		newestRunRowid(t),
		listRunRepos(t),
		listRunBranches(t),
		listRunAuthors(t),
		listRunAgents(t),
		listRunEvents(t),
	]);
	return runsListPage({
		account: scope.account,
		accounts: scope.accounts,
		login: scope.session.githubLogin,
		now,
		runs,
		total,
		page,
		perPage,
		newest,
		filters,
		options: { states: Object.keys(S.dashboard.list.states), repos, branches, authors, agents, events },
		...(await dashboardChrome(c, scope.session)),
	});
}

/** How many runs matching the filters were recorded after the run whose rowid is ?after, for the run list's banner. */
export async function dashboardRunsNewer(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const after = c.req.query("after") ?? "";
	if (!ROWID.test(after)) return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } });
	const [count, newest] = await Promise.all([countRunsAfter(scope.t, runFilterOf(filtersOf(c)), Number(after)), newestRunRowid(scope.t)]);
	return Response.json({ count, newest }, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" } });
}

export async function dashboardRun(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const runId = c.req.param("runId") ?? "";
	const run = await getRunListRow(scope.t, runId);
	if (!run) return notFoundPage();
	const [jobs, next] = await Promise.all([listJobsOfRun(scope.t, runId), getNextAttempt(scope.t, run)]);
	const now = (c.env.__TEST_CLOCK ?? systemClock).now();
	const chrome = await dashboardChrome(c, scope.session);
	const view = await runActionsView(c.env, c.req.raw, run, chrome.chrome?.csrf ?? null);
	const changes = await fetchCommitChanges(c.env, scope.account.id, run, now);
	return runPage({
		account: scope.account,
		login: scope.session.githubLogin,
		now,
		run,
		jobs,
		next,
		actions: view.actions,
		csrf: view.csrf,
		notice: view.notice,
		changes,
		annotations: await listRunAnnotations(c.env.DB, scope.account.id, runId),
		...chrome,
		cookies: [...(chrome.cookies ?? []), ...view.cookies],
	});
}

/** A commit's file list never changes, so a hit is good for a long time. The key carries the installation, so no installation reads another's answer. */
const CHANGES_TTL_S = 2_592_000;
const CHANGES_TIMEOUT_MS = 3000;

/** GitHub no longer has the commit (a force push) or never will: expected, not an error. */
function isGoneCommit(err: unknown): boolean {
	return err instanceof GitHubApiError && (err.githubStatus === 404 || err.githubStatus === 422);
}

async function loadCommitChanges(env: Env, installationId: number, run: RunListRow, owner: string, repo: string, now: number): Promise<CommitChanges> {
	const signal = AbortSignal.timeout(CHANGES_TIMEOUT_MS);
	const timedOut = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
	const load = (async () => {
		const gh = await new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => now).installation(installationId, {
			repositoryIds: [run.repo_id],
			permissions: { contents: "read" },
		});
		return getCommitChanges(gh, owner, repo, run.sha);
	})();
	load.catch(() => undefined);
	return Promise.race([load, timedOut]);
}

/** The commit's changed files from GitHub, or null (the page then leaves the card out) when GitHub cannot answer in time, no longer has the commit, or the repository is unknown. */
async function fetchCommitChanges(env: Env, installationId: number, run: RunListRow, now: number): Promise<CommitChanges | null> {
	const slash = run.repo_name === null ? -1 : run.repo_name.indexOf("/");
	if (run.repo_name === null || slash < 1) return null;
	const key = `https://commit-changes.hookci.invalid/${installationId}/${run.repo_id}/${run.sha}`;
	try {
		const hit = await caches.default.match(key);
		if (hit) return await hit.json<CommitChanges>();
		const changes = await loadCommitChanges(env, installationId, run, run.repo_name.slice(0, slash), run.repo_name.slice(slash + 1), now);
		await caches.default.put(key, Response.json(changes, { headers: { "Cache-Control": `public, max-age=${CHANGES_TTL_S}` } }));
		return changes;
	} catch (err) {
		if (!isGoneCommit(err)) reportError(err, { installation_id: installationId, run_id: run.run_id });
		return null;
	}
}
