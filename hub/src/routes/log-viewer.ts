// GET /logs/view: a job's log as an HTML page; GET /logs/raw: the same log as
// text; GET /logs/stream: a running job's log as server-sent events. All take the
// signed query signLogUrl writes. GET /logs/viewer.css and /logs/viewer.js: the
// page's stylesheet and live-tail script. The log holds output a fork pull
// request controls, so every response here carries a CSP without inline script
// and refuses framing.

import type { Context } from "hono";
import viewerCss from "../../static/viewer.css";
import viewerJs from "../../static/viewer.js";
import { getRepo } from "../db/repos";
import { getRun, type RunRow } from "../db/runs";
import { type TenantDb, tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { ansiToHtml } from "../logs/ansi";
import { logKey } from "../logs/keys";
import { SSE_HEADERS, offlineStream } from "../logs/live";
import { type LogRef, SIGNED_PARAMS, verifyLogUrl } from "../logs/signing";
import { splitStamp } from "../logs/stamp";
import { logEvent } from "../observability";
import { escapeHtml } from "../pages/layout";
import { QUOTAS } from "../quotas";
import { TERMINAL } from "../slack/badge";
import { S } from "../strings";

type ViewerContext = Context<{ Bindings: Env }>;

/** Decompressed bytes of a log the page renders; the rest is only in /logs/raw. */
export const RENDER_LIMIT_MIB = 5;
const RENDER_LIMIT_BYTES = RENDER_LIMIT_MIB * 1024 * 1024;
const TERMINAL_STATES: ReadonlySet<string> = TERMINAL;

const HEADERS: Readonly<Record<string, string>> = {
	"Content-Security-Policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
	"X-Frame-Options": "DENY",
	"X-Robots-Tag": "noindex",
};

/** An HTML response; title is escaped here, bodyHtml must already be safe HTML. */
function viewerPage(title: string, bodyHtml: string, status = 200): Response {
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/logs/viewer.css"></head>
<body>
${bodyHtml}
</body>
</html>`;
	return new Response(html, { status, headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}

/** A titled one-paragraph page under the viewer's security headers. */
export function noticePage(title: string, message: string, status: number): Response {
	return viewerPage(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`, status);
}

interface OpenRun {
	ref: LogRef;
	t: TenantDb;
	run: RunRow;
}

/** The signed link's run, or the 403 page to answer instead. */
async function openRun(c: ViewerContext): Promise<OpenRun | Response> {
	const env = c.env;
	const verdict = await verifyLogUrl(env, new URL(c.req.url).searchParams, new Date((env.__TEST_CLOCK ?? systemClock).now()));
	if (!verdict.ok) return noticePage(S.logViewer.linkExpiredTitle, S.logViewer.linkExpired, 403);

	const { ref } = verdict;
	const t = tenantDb(env.DB, ref.installationId);
	const run = await getRun(t, ref.runId);
	if (!run) {
		logEvent("tenant_denied", { installation_id: ref.installationId, run_id: ref.runId, job: ref.job, reason: "run_not_owned" });
		return noticePage(S.logViewer.linkExpiredTitle, S.logViewer.linkExpired, 403);
	}
	return { ref, t, run };
}

/** The signed query of this request, for a sibling /logs route. */
function signedLink(c: ViewerContext, path: string): string {
	const params = new URL(c.req.url).searchParams;
	return escapeHtml(`${path}?${new URLSearchParams(SIGNED_PARAMS.map((name) => [name, params.get(name) ?? ""]))}`);
}

/** Up to RENDER_LIMIT_BYTES of the gunzipped log as text, and whether more followed. */
export async function readRenderable(gzipped: ReadableStream<Uint8Array>): Promise<{ text: string; truncated: boolean }> {
	const reader = gzipped.pipeThrough(new DecompressionStream("gzip")).getReader();
	const decoder = new TextDecoder();
	let text = "";
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return { text: text + decoder.decode(), truncated: false };
		const room = RENDER_LIMIT_BYTES - size;
		if (value.byteLength > room) {
			await reader.cancel();
			return { text: text + decoder.decode(value.subarray(0, room)), truncated: true };
		}
		size += value.byteLength;
		text += decoder.decode(value, { stream: true });
	}
}

export async function viewLogPage(c: ViewerContext): Promise<Response> {
	const opened = await openRun(c);
	if (opened instanceof Response) return opened;
	const { ref, t, run } = opened;
	// The agent uploads a job's log once the job ends; until then a running run's page follows it live.
	const object = await c.env.LOGS.get(logKey(ref.installationId, ref.runId, ref.job));
	if (!object && TERMINAL_STATES.has(run.state)) return noticePage(S.logViewer.notFoundTitle, S.logViewer.notFound(QUOTAS.retentionDays), 404);

	const repo = await getRepo(t, run.repo_id);
	const repoName = repo?.full_name ?? S.logViewer.repoRemoved;
	const meta = `${escapeHtml(S.logViewer.run)} <code>${escapeHtml(ref.runId)}</code> · ${escapeHtml(S.logViewer.job)} <code>${escapeHtml(ref.job)}</code>`;
	if (!object) {
		return viewerPage(
			`${repoName} ${ref.job}`,
			`<h1>${escapeHtml(repoName)}</h1>
<p class="meta">${meta}</p>
<p class="notice" id="live" data-offline="${escapeHtml(S.logViewer.agentOffline)}" data-finished="${escapeHtml(S.logViewer.finished)}" data-lost="${escapeHtml(S.logViewer.streamLost)}">${escapeHtml(S.logViewer.live)}</p>
<pre class="log" id="log" data-stream="${signedLink(c, "/logs/stream")}"></pre>
<script src="/logs/viewer.js"></script>`,
		);
	}

	const { text: stored, truncated } = await readRenderable(object.body);
	const text = stored
		.split("\n")
		.map((line) => splitStamp(line).rest)
		.join("\n");
	const raw = signedLink(c, "/logs/raw");
	const notice = truncated
		? `\n<p class="notice">${escapeHtml(S.logViewer.truncated(RENDER_LIMIT_MIB))} <a href="${raw}">${escapeHtml(S.logViewer.downloadRaw)}</a></p>`
		: "";
	return viewerPage(
		`${repoName} ${ref.job}`,
		`<h1>${escapeHtml(repoName)}</h1>
<p class="meta">${meta} · <a href="${raw}">${escapeHtml(S.logViewer.raw)}</a></p>
<pre class="log">${ansiToHtml(text)}</pre>${notice}`,
	);
}

export async function rawLog(c: ViewerContext): Promise<Response> {
	const opened = await openRun(c);
	if (opened instanceof Response) return opened;
	const { ref } = opened;
	const object = await c.env.LOGS.get(logKey(ref.installationId, ref.runId, ref.job));
	if (!object) return noticePage(S.logViewer.notFoundTitle, S.logViewer.notFound(QUOTAS.retentionDays), 404);
	return new Response(object.body, {
		headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8", "Content-Encoding": "gzip", "Content-Disposition": "inline" },
		encodeBody: "manual",
	});
}

/** A running job's live log as server-sent events, proxied from its agent's AgentDO, which caps it at 60 minutes and sends keepalives. 409 once the run has finished. */
export async function liveTail(env: Env, run: RunRow, runId: string, job: string, signal: AbortSignal): Promise<Response> {
	if (TERMINAL_STATES.has(run.state)) return Response.json({ error: "run_finished" }, { status: 409, headers: HEADERS });
	const headers = { ...HEADERS, ...SSE_HEADERS };
	if (!run.agent_id) return new Response(offlineStream(), { headers });

	const agent = env.AGENT_DO.get(env.AGENT_DO.idFromName(run.agent_id));
	const tail = await agent.fetch(`https://do/tail?${new URLSearchParams({ run_id: runId, job, offset: "0" })}`, { signal });
	if (!tail.ok || !tail.body) throw new HubError("agent_tail_failed", 502, `AgentDO /tail answered ${tail.status}`);
	return new Response(tail.body, { headers });
}

/** GET /logs/stream: the signed link's job, live. */
export async function streamLog(c: ViewerContext): Promise<Response> {
	const opened = await openRun(c);
	if (opened instanceof Response) return opened;
	return liveTail(c.env, opened.run, opened.ref.runId, opened.ref.job, c.req.raw.signal);
}

export function viewerScript(): Response {
	return new Response(viewerJs, { headers: { ...HEADERS, "Content-Type": "text/javascript; charset=utf-8" } });
}

export function viewerStylesheet(): Response {
	return new Response(viewerCss, { headers: { ...HEADERS, "Content-Type": "text/css; charset=utf-8" } });
}
