// Server-rendered HTML for the browser flows. Every dynamic value goes
// through escapeHtml; every page response carries the same security headers.

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

export interface PageInit {
	status?: number;
	/** Set-Cookie header values. */
	cookies?: string[];
}

/**
 * The plain layout's only stylesheet: a readable, touch friendly column on phones, tablets and any touch screen.
 * Wide mouse driven screens keep the browser defaults. Inline styles are blocked by the CSP, so this one
 * stylesheet is pinned by hash; test/plain-layout.test.ts keeps PLAIN_CSS_HASH equal to its SHA-256.
 */
export const PLAIN_CSS = `@media (max-width:900px),(pointer:coarse){body{max-width:40rem;margin:0 auto;padding:16px max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));font:16px/1.5 system-ui,-apple-system,Roboto,sans-serif;overflow-wrap:anywhere}h1{margin:8px 0 16px;font-size:24px;line-height:1.25}h2{margin:24px 0 8px;font-size:19px;line-height:1.3}p,ul{margin:0 0 12px}li{margin-bottom:8px}ul{padding-left:20px}a{position:relative}a::after{content:'';position:absolute;left:-8px;right:-8px;top:50%;height:44px;transform:translateY(-50%)}code,pre{font-size:14px;white-space:pre-wrap}}`;

export const PLAIN_CSS_HASH = "sha256-Jcq+0ePmt+MDJJvZrS7s1jSSpBwnshrCZDY0+QugdLE=";

/** A complete HTML page response; title is escaped here, bodyHtml must already be safe HTML. */
export function page(title: string, bodyHtml: string, init: PageInit = {}): Response {
	const headers = new Headers({
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src '${PLAIN_CSS_HASH}'; frame-ancestors 'none'`,
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "no-store",
	});
	for (const cookie of init.cookies ?? []) headers.append("Set-Cookie", cookie);
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${escapeHtml(title)}</title><style>${PLAIN_CSS}</style></head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body>
</html>`;
	return new Response(html, { status: init.status ?? 200, headers });
}
