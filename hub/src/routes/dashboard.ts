// The read-only dashboard: GET /app, /app/login, /app/:installationId, its
// runs and their logs. The session cookie says which installations the user
// can see; anything it does not cover answers the same 404 page as a page that
// does not exist, so ids cannot be probed. Every lookup is scoped to the
// installation in the session, and a log's R2 key comes from the stored job
// row, never from the URL.

import type { Context } from "hono";
import { listAgents } from "../db/agents";
import { type InstallationRow, listLiveInstallations } from "../db/installations";
import { hitIpRate } from "../db/ip-rate";
import { getJobOfRun, getRunListRow, listJobsOfRun, listRunsPage } from "../db/runs";
import { type TenantDb, tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { redirectToAuthorize } from "../github/oauth";
import { issueState, readAnySession, type Session } from "../oauth/state";
import { logEvent } from "../observability";
import { noInstallationPage, notFoundPage, runPage, runsPage, signInPage } from "../pages/dashboard";
import { errorPage } from "../pages/error";
import { QUOTAS } from "../quotas";

type AppContext = Context<{ Bindings: Env }>;

const RATE_WINDOW_MS = 600_000;
const ID = /^[1-9][0-9]{0,15}$/;

/** What a session covering the installation in the URL has to work with. */
interface Scope {
	session: Session;
	account: InstallationRow;
	/** Every live installation the session covers, for the account switcher. */
	accounts: InstallationRow[];
	t: TenantDb;
}

/** The scope of :installationId, or null when the session is missing, expired, forged, or does not cover a live installation of that id. */
async function scopeOf(c: AppContext): Promise<Scope | null> {
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
	if (!session) return signInPage();
	const live = new Set((await listLiveInstallations(c.env.DB, session.installationIds)).map((a) => a.id));
	const first = session.installationIds.find((id) => live.has(id));
	if (first === undefined) return noInstallationPage();
	return new Response(null, { status: 303, headers: { Location: `/app/${first}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
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

export async function dashboardRuns(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const before = c.req.query("before");
	const limit = QUOTAS.dashboardRunsPerPage;
	const fetched = await listRunsPage(scope.t, limit + 1, before !== undefined && ID.test(before) ? Number(before) : undefined);
	const runs = fetched.slice(0, limit);
	const olderCursor = fetched.length > limit ? (runs[limit - 1]?.run_rowid ?? null) : null;
	const agents = (await listAgents(scope.t)).filter((a) => a.status !== "revoked");
	return runsPage({ account: scope.account, accounts: scope.accounts, login: scope.session.githubLogin, runs, olderCursor, agents });
}

export async function dashboardRun(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const runId = c.req.param("runId") ?? "";
	const run = await getRunListRow(scope.t, runId);
	if (!run) return notFoundPage();
	const jobs = await listJobsOfRun(scope.t, runId);
	return runPage({ account: scope.account, login: scope.session.githubLogin, run, jobs });
}

/** The job's log, decompressed. It holds output a fork pull request controls, so it is served as inert text. */
export async function dashboardLog(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const runId = c.req.param("runId") ?? "";
	const job = await getJobOfRun(scope.t, runId, c.req.param("job") ?? "");
	if (!job?.log_key) return notFoundPage();
	if (!job.log_key.startsWith(`logs/${scope.account.id}/${runId}/`)) {
		logEvent("tenant_denied", { installation_id: scope.account.id, run_id: runId, job: job.name, reason: "dashboard_log_key_foreign" });
		return notFoundPage();
	}
	const object = await c.env.LOGS.get(job.log_key);
	if (!object) return notFoundPage();
	return new Response(object.body.pipeThrough(new DecompressionStream("gzip")), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Robots-Tag": "noindex",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "sandbox",
			"Content-Disposition": "inline",
			"Referrer-Policy": "no-referrer",
		},
	});
}
