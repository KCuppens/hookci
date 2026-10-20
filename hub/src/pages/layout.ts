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

/** A complete HTML page response; title is escaped here, bodyHtml must already be safe HTML. */
export function page(title: string, bodyHtml: string, init: PageInit = {}): Response {
	const headers = new Headers({
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "no-store",
	});
	for (const cookie of init.cookies ?? []) headers.append("Set-Cookie", cookie);
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body>
</html>`;
	return new Response(html, { status: init.status ?? 200, headers });
}
