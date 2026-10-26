import { S } from "../strings";
import { BRAND_CSS, brandLink, LOGO_DEFS } from "./brand";
import { escapeHtml, type PageInit } from "./layout";

// The visual system shared by every styled hub page: tokens, nav, logo, footer, blobs and curves, icons and
// the response builder. A page supplies only its own CSS, markup and (rarely) one script; the shell joins
// its CSS with SHELL_CSS and pins the result by SHA-256 in a strict CSP, so there is exactly one inline
// stylesheet per page and no external font, image or script.

const T = S.site;
const e = escapeHtml;

export const FONT = `"Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/** A soft orange radial glow for a page background; pass the ellipse radii, its centre and a peak alpha. */
export const blob = (rx: number, ry: number, at: string, a = 0.26): string =>
	`radial-gradient(ellipse ${rx}px ${ry}px at ${at},rgba(255,106,44,${a}) 0,rgba(255,106,44,${(a * 0.5).toFixed(3)}) 40%,rgba(255,106,44,${(a * 0.14).toFixed(3)}) 75%,rgba(255,106,44,0) 100%)`;

export const FONT_PATH = "/assets/inter.woff2";

/** Tokens, reset, header, footer, buttons and background layers. Page CSS is appended after it. */
export const SHELL_CSS = `
@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;font-display:block;src:url(${FONT_PATH}) format("woff2")}
:root{--ink:#0f141d;--ink-2:#3b4350;--muted:#6b7280;--line:#e8e9ec;--line-2:#eeeef1;--orange:#ff6a2c;--orange-soft:#fff1ea;--orange-line:#ffb08f;--nh:81px;--app-w:1410px;--gutter:24px;--edge:max(var(--gutter),calc((100% - var(--app-w)) / 2));--ls:.139;--ly:0px;--ry:0px;--nfs:15px;--ph:41px;--pw:14.5px;--ffs:14.5px;--fp:29px;--g10:21px;--bh:51px;--bfs:16px;--br:10px;--g6:0px}
button.busy{opacity:.7;cursor:wait;pointer-events:none}
@media (prefers-color-scheme:dark){
:root{--ink:#f0f3f8;--ink-2:#c2c9d6;--muted:#8b94a5;--line:#282d38;--line-2:#1f242e;--orange:#ff7d45;--orange-soft:#2a1a14;--orange-line:#733219}
body{background:#0e1117!important;color:var(--ink)!important}
.card{background:#161b22!important;border-color:#282d38!important}
.app{background:#161b22!important;border-bottom-color:#282d38!important}
.tabs a{color:#8b94a5!important}
.tabs a:hover,.tabs a.on{color:#f0f3f8!important}
.ob{background:#21262d!important;border-color:#30363d!important;color:#c9d1d9!important}
.ob:hover{background:#30363d!important}
.ob.dk{background:#ff6a2c!important;border-color:#ff6a2c!important;color:#fff!important}
input,select,textarea{background:#0d1117!important;border-color:#30363d!important;color:#f0f3f8!important}
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{position:relative;min-height:100vh;overflow-x:hidden;background:#fafafa;color:var(--ink);font-family:${FONT};font-size:16px;line-height:1.4;letter-spacing:.005em;-webkit-font-smoothing:antialiased}
a{color:inherit}
[hidden]{display:none}
.defs{position:absolute;width:0;height:0;overflow:hidden}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.bg,.curves{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.cv{fill:none;stroke:#ff8a54;stroke-width:.8}
.dt{fill:#fd6810}
.ic{display:block;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.nav{position:relative;z-index:3;display:flex;align-items:center;justify-content:space-between;height:var(--nh);padding:0 var(--edge)}
${BRAND_CSS}
.navr{display:flex;align-items:center;transform:translateY(var(--ry))}
.links{display:flex;align-items:center;gap:36px;margin-right:42px}
.links a{color:#5f6673;font-size:var(--nfs);text-decoration:none}
.links a:hover{color:var(--ink)}
.pill{display:inline-flex;align-items:center;gap:12px;height:var(--ph);padding:0 18px 0 20px;border:1px solid #e1e3e7;border-radius:999px;background:#fff;color:var(--ink);font-size:var(--pw);font-weight:500;text-decoration:none;box-shadow:0 1px 2px rgba(15,20,29,.03),0 6px 20px rgba(15,20,29,.05)}
.pill .ic{width:22px;height:22px;stroke:none;fill:currentColor}
.tile{display:grid;place-items:center;flex:none;background:#feebe2;color:var(--orange);border:1px solid #ffd6c2}
.tile .ic{width:28px;height:28px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:var(--bh);margin-top:var(--g6);border:0;border-radius:var(--br);background:#161a23;color:#fff;font-family:inherit;font-size:var(--bfs);font-weight:500;text-decoration:none;cursor:pointer}
.btn:hover{background:#2a303c}
.btn .ic{width:18px;height:18px}
.btn .gh{stroke:none;fill:currentColor}
.btn.ghost{border:1px solid #e3e6ea;background:#fff;color:var(--ink)}
.btn.ghost:hover{background:#fcfcfd}
.foot{display:flex;justify-content:center;margin-top:var(--g10);font-size:var(--ffs)}
.foot a{padding:0 var(--fp);color:var(--muted);line-height:16px;text-decoration:none}
.foot a+a{border-left:1px solid #d3d6db}
.foot a:hover{color:var(--ink)}
.mm{display:none}
@media (max-width:640px){
:root{--gutter:16px}
}
@media (max-width:900px){
.links,.curves{display:none}
.pill.ico{width:40px;padding:0;justify-content:center;gap:0}
.pill.ico span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.pill.ghp{display:none}
body{padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);padding-bottom:env(safe-area-inset-bottom)}
.navr{transform:none}
.mm{display:block;margin-left:8px}
.mm summary{display:grid;place-items:center;width:44px;height:44px;border:1px solid #e1e3e7;border-radius:12px;background:#fff;color:var(--ink);list-style:none;cursor:pointer}
.mm summary::-webkit-details-marker{display:none}
.mm .ic{width:22px;height:22px}
.mmp{position:absolute;top:100%;right:12px;z-index:5;display:flex;flex-direction:column;gap:8px;width:min(240px,calc(100vw - 24px));padding:8px;border:1px solid #e1e3e7;border-radius:14px;background:#fff;box-shadow:0 8px 28px rgba(15,20,29,.12)}
.mmp a{display:flex;align-items:center;min-height:44px;padding:0 12px;border-radius:8px;color:var(--ink);font-size:16px;text-decoration:none}
.mmp a:hover{background:#f4f5f7}
.mm summary:focus-visible,.mmp a:focus-visible{outline:2px solid var(--orange);outline-offset:2px}
.mm:not([open]) .mmp{display:none}
.brand{position:relative}
.brand::after{content:"";position:absolute;inset:-12px 0}
}
@media (max-width:900px),(pointer:coarse){
.btn{min-height:44px}
.pill{min-height:44px}
.pill.ico{min-width:44px}
.links a{display:inline-flex;align-items:center;min-height:44px;padding:0 4px}
.foot{flex-wrap:wrap;gap:0 8px}
.foot a{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0 12px}
input,select,textarea{font-size:16px}
}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}
}
`;

const hashes = new Map<string, Promise<string>>();

/** A CSP hash source: the SHA-256 of the text in base64, computed once per distinct text. */
export function sha256Source(text: string): Promise<string> {
	let hash = hashes.get(text);
	if (hash === undefined) {
		hash = crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then((digest) => {
			let binary = "";
			for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
			return `'sha256-${btoa(binary)}'`;
		});
		hashes.set(text, hash);
	}
	return hash;
}

// Stroke icons share a 24x24 grid; the filled brand marks carry their own fills.
const ICONS: Record<string, string> = {
	mail: `<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 8 8 5.5L20 8"/>`,
	lock: `<rect x="5" y="11" width="14" height="10" rx="2.6"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><path d="M12 15.2v2"/>`,
	eye: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>`,
	"eye-off": `<path d="M3 3l18 18"/><path d="M10.6 6a9 9 0 0 1 1.4-.1c6 0 9.5 6.1 9.5 6.1a16 16 0 0 1-2.6 3.3M6.6 7.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>`,
	bolt: `<path d="M13 2.5 4.5 13.5h6.5L10 21.5l9-11.5h-6.5z"/>`,
	list: `<path d="M9.5 6.5h11M9.5 12h11M9.5 17.5h11"/><circle cx="4.8" cy="6.5" r=".6"/><circle cx="4.8" cy="12" r=".6"/><circle cx="4.8" cy="17.5" r=".6"/>`,
	chart: `<rect x="3.5" y="12" width="4.6" height="8.5" rx="1.2"/><rect x="9.7" y="4" width="4.6" height="16.5" rx="1.2"/><rect x="15.9" y="8.5" width="4.6" height="12" rx="1.2"/>`,
	shield: `<path d="M12 3 4.8 5.8v5.6c0 4.5 3 8 7.2 9.6 4.2-1.6 7.2-5.1 7.2-9.6V5.8z"/><path d="m9 12 2.3 2.3L15.3 10"/>`,
	folder: `<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>`,
	server: `<rect x="4" y="3.5" width="16" height="7" rx="2"/><rect x="4" y="13.5" width="16" height="7" rx="2"/><path d="M8 7h.01M8 17h.01M12 7h4M12 17h4"/>`,
	nodes: `<circle cx="12" cy="5" r="2.3"/><circle cx="5" cy="18" r="2.3"/><circle cx="19" cy="18" r="2.3"/><circle cx="12" cy="13" r="1.6"/><path d="M12 7.3V11.4M10.7 14.1 6.6 16.6M13.3 14.1l4.1 2.5"/>`,
	book: `<path d="M12 6.2C10.3 4.9 8 4.2 5 4.2v13c3 0 5.3.7 7 2 1.7-1.3 4-2 7-2v-13c-3 0-5.3.7-7 2z"/><path d="M12 6.2v13"/>`,
	arrow: `<path d="M5 12h14M13 6l6 6-6 6"/>`,
	back: `<path d="M19 12H5M11 6l-6 6 6 6"/>`,
	check: `<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.8 2.8 5.2-5.6"/>`,
	alert: `<path d="M12 3.6 2.9 19.4h18.2z"/><path d="M12 10v4.4M12 17.4v.1"/>`,
	github: `<path fill="currentColor" stroke="none" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>`,
	menu: `<path d="M4 7h16M4 12h16M4 17h16"/>`,
	google: `<path fill="#4285F4" stroke="none" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" stroke="none" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" stroke="none" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.83z"/><path fill="#EA4335" stroke="none" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.9 10.9 0 0 0 12 1 11 11 0 0 0 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>`,
};

/** The GitHub mark is drawn on a 16-unit grid. */
const SYMBOL_BOX: Record<string, string> = { github: "0 0 16 16" };

export function icon(name: string, cls = ""): string {
	return `<svg class="ic${cls ? ` ${cls}` : ""}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
}

/** Symbol definitions for exactly the icons the page body uses (plus the logo path); extra icons are page specific. */
function defs(body: string, extra: Readonly<Record<string, string>>): string {
	const used = new Set<string>();
	for (const m of body.matchAll(/href="#i-([a-z0-9-]+)"/g)) used.add(m[1] ?? "");
	let out = `<svg class="defs" aria-hidden="true" focusable="false"><defs>${LOGO_DEFS}`;
	for (const name of used) {
		const glyph = extra[name] ?? ICONS[name];
		if (glyph) out += `<symbol id="i-${name}" viewBox="${SYMBOL_BOX[name] ?? "0 0 24 24"}">${glyph}</symbol>`;
	}
	return `${out}</defs></svg>`;
}

/** Docs and Pricing on the marketing site, Support on the hub. */
export function siteLinks(): string {
	return (
		`<nav class="links" aria-label="Site"><a href="${e(T.docsUrl)}" rel="noopener noreferrer">${e(T.navDocs)}</a>` +
		`<a href="${e(T.pricingUrl)}" rel="noopener noreferrer">${e(T.navPricing)}</a><a href="/support">${e(T.navSupport)}</a></nav>`
	);
}

/** The "View on GitHub" pill; icon only on small screens, where the menu carries the same link. */
export function githubPill(): string {
	return `<a class="pill ico ghp" href="${e(T.githubUrl)}" rel="noopener noreferrer">${icon("github")}<span>${e(T.navGithub)}</span></a>`;
}

/** The no-JS menu shown at 900px and below: Docs, Pricing, Support and GitHub. Hidden above that. */
function siteMenu(): string {
	return (
		`<details class="mm"><summary aria-label="${e(T.navMenu)}">${icon("menu")}</summary><div class="mmp">` +
		`<a href="${e(T.docsUrl)}" rel="noopener noreferrer">${e(T.navDocs)}</a><a href="${e(T.pricingUrl)}" rel="noopener noreferrer">${e(T.navPricing)}</a>` +
		`<a href="/support">${e(T.navSupport)}</a><a href="${e(T.githubUrl)}" rel="noopener noreferrer">${e(T.navGithub)}</a></div></details>`
	);
}

/** The marketing header: logo left, links and one right-hand control. */
export function siteNav(right: string = githubPill()): string {
	return `<header class="nav">${brandLink()}<div class="navr">${siteLinks()}${right}${siteMenu()}</div></header>`;
}

/** Privacy, Terms and Support. */
export function legalFooter(cls = ""): string {
	return `<nav class="foot${cls}" aria-label="Legal"><a href="/privacy">${e(T.footerPrivacy)}</a><a href="/terms">${e(T.footerTerms)}</a><a href="/support">${e(T.footerSupport)}</a></nav>`;
}

export interface ShellPage {
	title: string;
	/** Class on body, so page CSS can scope itself. */
	bodyClass: string;
	/** The page's own CSS, appended to SHELL_CSS. */
	css: string;
	/** Markup after the background layers: the header and main. */
	body: string;
	/** Curve paths on a 1024x683 grid, drawn behind the page. */
	curves?: string;
	/** One inline script, pinned by hash. */
	script?: string | undefined;
	/** The script may fetch same-origin URLs. */
	connect?: boolean;
	/** Icons beyond the shared set, by name. */
	icons?: Readonly<Record<string, string>>;
	/** Whether forms may post back to the hub; default yes. */
	forms?: boolean;
	/** Origins images may load from (img-src); omitted means no images at all. */
	imgSrc?: readonly string[];
}

/** A complete styled page response with the strict CSP, no-store and no-referrer. */
export async function shellResponse(p: ShellPage, init: PageInit = {}): Promise<Response> {
	const css = SHELL_CSS + p.css;
	const style = await sha256Source(css);
	const script = p.script === undefined ? "" : ` script-src ${await sha256Source(p.script)};`;
	const connect = p.connect ? " connect-src 'self';" : "";
	const img = p.imgSrc === undefined ? "" : ` img-src ${p.imgSrc.join(" ")};`;
	const headers = new Headers({
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": `default-src 'none'; style-src ${style}; font-src 'self';${script}${connect}${img} base-uri 'none'; form-action ${p.forms === false ? "'none'" : "'self'"}; frame-ancestors 'none'`,
		"X-Content-Type-Options": "nosniff",
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	});
	for (const cookie of init.cookies ?? []) headers.append("Set-Cookie", cookie);
	const curves = p.curves === undefined ? "" : `<svg class="curves" viewBox="0 0 1024 683" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${p.curves}</svg>`;
	const inner = `<div class="bg" aria-hidden="true"></div>${curves}${p.body}`;
	const html =
		`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${e(p.title)}</title><link rel="preload" href="${FONT_PATH}" as="font" type="font/woff2" crossorigin><style>${css}</style></head>` +
		`<body class="${e(p.bodyClass)}">${defs(inner, p.icons ?? {})}${inner}${p.script === undefined ? "" : `<script>${p.script}</script>`}</body></html>`;
	return new Response(html, { status: init.status ?? 200, headers });
}
