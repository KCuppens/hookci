// The dashboard's job logs: the viewer page, the raw text and the download. All three go through scopeOf (the session must cover the
// installation, anything else is the same 404 page) and a log's R2 key comes from the stored job row, never from the URL. A log holds
// output a fork pull request controls: the raw and download routes serve it as inert text and the viewer escapes every line.

import type { Context } from "hono";
import { getJobOfRun, getRun, getRunListRow, type JobLogRow, listJobsOfRun } from "../db/runs";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { type LogLine, readLogHead, renderLines, VIEW_BYTES } from "../logs/render";
import { logEvent, reportError } from "../observability";
import { notFoundPage } from "../pages/dashboard";
import { type LogState, runLogsPage } from "../pages/run-logs";
import { dashboardChrome } from "./account";
import { type Scope, scopeOf } from "./dashboard";
import { liveTail } from "./log-viewer";

type AppContext = Context<{ Bindings: Env }>;

/** Job states in which the agent may still upload the log. */
const ACTIVE: Record<string, true> = { received: true, gated: true, pending: true, queued: true, running: true, verifying: true, rolling_back: true };

interface Shown {
	state: LogState;
	lines: LogLine[];
	cut: boolean;
}

/** True (and logged) when the job row's log key does not belong to the installation in the session. */
function foreignKey(scope: Scope, runId: string, job: JobLogRow): boolean {
	if (job.log_key === null || job.log_key.startsWith(`logs/${scope.account.id}/${runId}/`)) return false;
	logEvent("tenant_denied", { installation_id: scope.account.id, run_id: runId, job: job.name, reason: "dashboard_log_key_foreign" });
	return true;
}

/** The job's log decompressed and served as inert text; disposition is the Content-Disposition value. */
async function serveLog(c: AppContext, disposition: string): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const runId = c.req.param("runId") ?? "";
	const job = await getJobOfRun(scope.t, runId, c.req.param("job") ?? "");
	if (!job?.log_key || foreignKey(scope, runId, job)) return notFoundPage();
	const object = await c.env.LOGS.get(job.log_key);
	if (!object) return notFoundPage();
	return new Response(object.body.pipeThrough(new DecompressionStream("gzip")), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Robots-Tag": "noindex",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "sandbox",
			"Content-Disposition": disposition,
			"Referrer-Policy": "no-referrer",
		},
	});
}

/** The job's log as text shown inline. */
export function dashboardLog(c: AppContext): Promise<Response> {
	return serveLog(c, "inline");
}

/** The same text as a download named after the job. */
export function dashboardLogDownload(c: AppContext): Promise<Response> {
	const name = (c.req.param("job") ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "job";
	return serveLog(c, `attachment; filename="${name}.log"`);
}

/** What the viewer has for the job: the log's first lines, or the reason there are none. */
async function readShown(env: Env, installationId: number, runId: string, job: JobLogRow): Promise<Shown> {
	if (job.log_key !== null) {
		const object = await env.LOGS.get(job.log_key);
		if (!object) return { state: "expired", lines: [], cut: false };
		try {
			const head = await readLogHead(object.body.pipeThrough(new DecompressionStream("gzip")), VIEW_BYTES);
			return { state: "available", lines: renderLines(head.text), cut: head.cut };
		} catch (err) {
			reportError(err, { installation_id: installationId, run_id: runId, job: job.name });
			return { state: "failed", lines: [], cut: false };
		}
	}
	if (job.logs_local === 1) return { state: "local", lines: [], cut: false };
	return { state: Object.hasOwn(ACTIVE, job.state) ? "queued" : "failed", lines: [], cut: false };
}

export async function dashboardLogView(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const runId = c.req.param("runId") ?? "";
	const run = await getRunListRow(scope.t, runId);
	const job = run ? await getJobOfRun(scope.t, runId, c.req.param("job") ?? "") : null;
	if (!run || !job || foreignKey(scope, runId, job)) return notFoundPage();
	const [jobs, shown] = await Promise.all([listJobsOfRun(scope.t, runId), readShown(c.env, scope.account.id, runId, job)]);
	return runLogsPage({
		account: scope.account,
		login: scope.session.githubLogin,
		now: (c.env.__TEST_CLOCK ?? systemClock).now(),
		run,
		jobs,
		job,
		...shown,
		...(await dashboardChrome(c, scope.session)),
	});
}

/** The job's live log as server-sent events for the run page's inline tail; the session must cover the installation and the job must be the run's. */
export async function dashboardLogStream(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const runId = c.req.param("runId") ?? "";
	const run = await getRun(scope.t, runId);
	const job = run ? await getJobOfRun(scope.t, runId, c.req.param("job") ?? "") : null;
	if (!run || !job) return notFoundPage();
	return liveTail(c.env, run, runId, job.name, c.req.raw.signal);
}
