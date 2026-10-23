// The public documents and RFC 9116 security.txt. /privacy, /terms, /support
// and /security render the repository's markdown, baked into legal/content.ts
// by scripts/gen-legal.mjs; /.well-known/security.txt points at /security.

import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { LEGAL_DOCS } from "../legal/content";
import { renderMarkdownSubset } from "../legal/markdown";
import { escapeHtml } from "../pages/layout";
import { S } from "../strings";

const DAY_MS = 24 * 60 * 60 * 1000;
/** RFC 9116 wants Expires less than a year away; it moves with the clock, so it never lapses. */
const SECURITY_TXT_LIFETIME_MS = 365 * DAY_MS;
const SECURITY_TXT_PATH = "/.well-known/security.txt";

type LegalDoc = keyof typeof LEGAL_DOCS;

const DOC_PATHS: Readonly<Record<string, LegalDoc>> = {
	"/privacy": "privacy",
	"/terms": "terms",
	"/support": "support",
	"/security": "security",
};

/** Every path handleWellKnown answers; app.ts routes each one to it. */
export const WELL_KNOWN_PATHS: readonly string[] = [SECURITY_TXT_PATH, ...Object.keys(DOC_PATHS)];

const DOC_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "public, max-age=3600",
};

const STYLE =
	"body{font-family:system-ui,sans-serif;line-height:1.5;max-width:46rem;margin:2rem auto;padding:0 1rem}" +
	"table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:.3rem .6rem;text-align:left;vertical-align:top}" +
	"code{background:#f3f3f3;padding:0 .2rem}";

/** Rendered pages by document; the markdown is fixed at build time, so each renders once per isolate. */
const rendered = new Map<LegalDoc, string>();

function documentHtml(doc: LegalDoc): string {
	let html = rendered.get(doc);
	if (html === undefined) {
		const markdown = LEGAL_DOCS[doc];
		const title = /^#{1,6}\s+(.+?)\s*$/m.exec(markdown)?.[1] ?? doc;
		html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>
${renderMarkdownSubset(markdown)}
</body>
</html>`;
		rendered.set(doc, html);
	}
	return html;
}

/** The RFC 9116 body; Contact falls back to GitHub's private advisories while SECURITY_CONTACT is empty. */
export function securityTxt(env: Env, now: Date): string {
	const expires = new Date(now.getTime() + SECURITY_TXT_LIFETIME_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
	return [
		`Contact: ${env.SECURITY_CONTACT || S.pages.securityAdvisoryUrl}`,
		`Expires: ${expires}`,
		`Policy: ${env.HUB_ORIGIN}/security`,
		"Preferred-Languages: en",
		`Canonical: ${env.HUB_ORIGIN}${SECURITY_TXT_PATH}`,
		"",
	].join("\n");
}

/** The response for a GET or HEAD of one of WELL_KNOWN_PATHS, or null for any other request. */
export function handleWellKnown(req: Request, env: Env): Response | null {
	if (req.method !== "GET" && req.method !== "HEAD") return null;
	const path = new URL(req.url).pathname;
	if (path === SECURITY_TXT_PATH) {
		const now = new Date((env.__TEST_CLOCK ?? systemClock).now());
		return new Response(securityTxt(env, now), {
			headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
		});
	}
	const doc = DOC_PATHS[path];
	return doc ? new Response(documentHtml(doc), { headers: DOC_HEADERS }) : null;
}
