// GET /logs/view: a job's log as an HTML page; GET /logs/raw: the same log as
// text. Both take the signed query signLogUrl writes. GET /logs/viewer.css: the
// page's stylesheet. The log holds output a fork pull request controls, so
// every response here carries a CSP without inline script and refuses framing.

import type { Context } from "hono";
import viewerCss from "../../static/viewer.css";
import { getRepo } from "../db/repos";
import { getRun, type RunRow } from "../db/runs";
import { type TenantDb, tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { ansiToHtml } from "../logs/ansi";
import { logKey } from "../logs/keys";
import { type LogRef, SIGNED_PARAMS, verifyLogUrl } from "../logs/signing";
import { logEvent } from "../observability";
import { escapeHtml } from "../pages/layout";
import { QUOTAS } from "../quotas";
import { S } from "../strings";

type ViewerContext = Context<{ Bindings: Env }>;

/** Decompressed bytes of a log the page renders; the rest is only in /logs/raw. */
export const RENDER_LIMIT_MIB = 5;
const RENDER_LIMIT_BYTES = RENDER_LIMIT_MIB * 1024 * 1024;

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

function noticePage(title: string, message: string, status: number): Response {
	return viewerPage(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`, status);
}

interface OpenLog {
	ref: LogRef;
	t: TenantDb;
	run: RunRow;
	object: R2ObjectBody;
}

/** The signed link's log, or the 403 or 404 page to answer instead. */
async function openLog(c: ViewerContext): Promise<OpenLog | Response> {
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
	const object = await env.LOGS.get(logKey(ref.installationId, ref.runId, ref.job));
	if (!object) return noticePage(S.logViewer.notFoundTitle, S.logViewer.notFound(QUOTAS.retentionDays), 404);
	return { ref, t, run, object };
}

/** Up to RENDER_LIMIT_BYTES of the gunzipped log as text, and whether more followed. */
async function readRenderable(gzipped: ReadableStream<Uint8Array>): Promise<{ text: string; truncated: boolean }> {
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
	const opened = await openLog(c);
	if (opened instanceof Response) return opened;
	const { ref, t, run, object } = opened;

	const repo = await getRepo(t, run.repo_id);
	const { text, truncated } = await readRenderable(object.body);
	const params = new URL(c.req.url).searchParams;
	const raw = escapeHtml(`/logs/raw?${new URLSearchParams(SIGNED_PARAMS.map((name) => [name, params.get(name) ?? ""]))}`);
	const repoName = repo?.full_name ?? S.logViewer.repoRemoved;
	const notice = truncated
		? `\n<p class="notice">${escapeHtml(S.logViewer.truncated(RENDER_LIMIT_MIB))} <a href="${raw}">${escapeHtml(S.logViewer.downloadRaw)}</a></p>`
		: "";
	return viewerPage(
		`${repoName} ${ref.job}`,
		`<h1>${escapeHtml(repoName)}</h1>
<p class="meta">${escapeHtml(S.logViewer.run)} <code>${escapeHtml(ref.runId)}</code> · ${escapeHtml(S.logViewer.job)} <code>${escapeHtml(ref.job)}</code> · <a href="${raw}">${escapeHtml(S.logViewer.raw)}</a></p>
<pre class="log">${ansiToHtml(text)}</pre>${notice}`,
	);
}

export async function rawLog(c: ViewerContext): Promise<Response> {
	const opened = await openLog(c);
	if (opened instanceof Response) return opened;
	return new Response(opened.object.body, {
		headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8", "Content-Encoding": "gzip", "Content-Disposition": "inline" },
		encodeBody: "manual",
	});
}

export function viewerStylesheet(): Response {
	return new Response(viewerCss, { headers: { ...HEADERS, "Content-Type": "text/css; charset=utf-8" } });
}
