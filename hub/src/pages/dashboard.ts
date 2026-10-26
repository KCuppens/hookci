// The dashboard chrome and what its pages share, built on the shared shell
// (shell.ts). Every dynamic value goes through escapeHtml. The one inline
// stylesheet and the one page script (PAGE_SCRIPT) are pinned by hash in the CSP.

import type { AgentRow } from "../db/agents";
import type { InstallationRow } from "../db/installations";
import type { OverviewData } from "../db/overview";
import type { RunListRow } from "../db/runs";
import { TERMINAL } from "../slack/badge";
import { S } from "../strings";
import { AVATAR_GLYPH, brandLink } from "./brand";
import { escapeHtml, type PageInit } from "./layout";
import { stateLook } from "./pills";
import { icon, shellResponse } from "./shell";

const D = S.dashboard;
const O = D.overview;
const e = escapeHtml;

/** Icons beyond the shared set, on the 24 grid like the rest. */
const EXTRA_ICONS: Record<string, string> = {
	x: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>',
	dots: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>',
	play: '<circle cx="12" cy="12" r="9"/><path d="M10.2 8.6l5 3.4-5 3.4z"/>',
	clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
	layers: '<path d="M12 4l8 4.5-8 4.5-8-4.5z"/><path d="M4 12.5l8 4.5 8-4.5M4 16.5l8 4.5 8-4.5"/>',
	ban: '<circle cx="12" cy="12" r="9"/><path d="M5.8 18.2L18.2 5.8"/>',
	skip: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
	user: AVATAR_GLYPH,
	chev: '<path d="M9.5 6l6 6-6 6"/>',
	search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
	branch: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 8v8M17 10c0 4-6 3-10 6"/>',
	slack: '<path d="M9.5 4v16M14.5 4v16M4 9.5h16M4 14.5h16"/>',
	out: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
	"g-tick": '<path d="m6.8 12.6 3.4 3.4 7-7.6"/>',
	"g-x": '<path d="M8 8l8 8M16 8l-8 8"/>',
	"g-dots": '<path d="M7.5 12h.01M12 12h.01M16.5 12h.01" stroke-width="3"/>',
	"g-play": '<path d="M9.5 7.5v9l7-4.5z"/>',
	"g-pause": '<path d="M9.5 8v8M14.5 8v8"/>',
	"g-stack": '<path d="M12 6l6 3.2-6 3.2-6-3.2z"/><path d="M6 12.6l6 3.2 6-3.2"/>',
	"g-minus": '<path d="M8 12h8"/>',
	"g-bang": '<path d="M12 7.5v5.5M12 16.6v.1" stroke-width="2.6"/>',
	"g-ban": '<circle cx="12" cy="12" r="5.5"/><path d="M8.2 15.8l7.6-7.6"/>',
	"g-eye": '<circle cx="11" cy="11" r="4.2"/><path d="M14.2 14.2 17 17"/>',
	ellipsis: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>',
	chevd: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
};

const CSS = `
body{background:#f8f8fa}
.app{position:relative;z-index:3;background:#fff;border-bottom:1px solid var(--line);--ls:.085}
.app .in{display:flex;align-items:center;gap:44px;width:calc(100% - 2 * var(--gutter));max-width:var(--app-w);height:64px;margin:0 auto;padding:0}
.tabs{display:flex;align-self:stretch;gap:30px}
.tabs a{display:flex;align-items:center;margin-bottom:-1px;border-bottom:2px solid transparent;color:#4b5563;font-size:14px;text-decoration:none}
.tabs a:hover{color:var(--ink)}
.tabs a.on{border-color:var(--orange);color:var(--ink);font-weight:600}
.rt{display:flex;align-items:center;gap:18px;margin-left:auto;font-size:14px}
.rt a,.rt button{color:#4b5563;text-decoration:none}
.rt form{display:flex}
.rt button{padding:0;border:0;background:none;font:inherit;cursor:pointer}
.rt a:hover,.rt button:hover{color:var(--ink)}
.usr{display:grid;place-items:center;width:34px;height:34px;border:1px solid #dfe2e6;border-radius:50%;background:#fff;color:#4b5563}
.usr .ic{width:19px;height:19px}
.main{position:relative;z-index:2;width:calc(100% - 2 * var(--gutter));max-width:var(--app-w);margin:0 auto;padding:32px 0 72px}
.accts{display:flex;flex-wrap:wrap;gap:6px 16px;margin:0 0 14px;padding:0;list-style:none;font-size:14px;color:var(--muted)}
.accts strong{color:var(--ink)}
.ph{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:24px}
h1{font-size:34px;font-weight:700;letter-spacing:-.02em;line-height:1.15;overflow-wrap:anywhere}
.sub{margin-top:8px;color:var(--muted);font-size:15px}
.card{overflow:hidden;border:1px solid var(--line);border-radius:14px;background:#fff;box-shadow:0 1px 2px rgba(15,20,29,.03)}
.ch{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 22px;border-bottom:1px solid var(--line-2)}
.ch h2{font-size:17px;font-weight:600}
.ch a,.lnk{display:inline-flex;align-items:center;gap:6px;color:#2563eb;font-size:14px;font-weight:500;text-decoration:none}
.ch a .ic,.lnk .ic{width:15px;height:15px}
.stack-gap>*+*{margin-top:20px}
.ob{display:inline-flex;align-items:center;gap:8px;flex:none;height:38px;padding:0 14px;border:1px solid #e3e6ea;border-radius:9px;background:#fff;color:var(--ink);font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap}
.ob:hover{background:#fcfcfd}
.ob .ic{width:15px;height:15px}
.ob.dk{border-color:#161a23;background:#161a23;color:#fff}
.ob.dk:hover{background:#2a303c}
[hidden]{display:none!important}
.mnu{position:relative;display:inline-block}
.mnu summary{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;color:#6b7280;list-style:none;cursor:pointer}
.mnu summary::-webkit-details-marker{display:none}
.mnu summary:hover,.mnu[open] summary{background:#f1f2f4;color:var(--ink)}
.mnu .ic{width:20px;height:20px}
.menu{position:absolute;z-index:5;right:0;top:32px;min-width:170px;padding:6px;border:1px solid var(--line);border-radius:10px;background:#fff;box-shadow:0 8px 24px rgba(15,20,29,.12);text-align:left}
.menu a,.menu button{display:block;width:100%;padding:8px 10px;border:0;border-radius:6px;background:none;color:var(--ink);font:inherit;font-size:13.5px;font-weight:500;text-align:left;text-decoration:none;cursor:pointer}
.menu a:hover,.menu button:hover{background:#f4f5f7}
.menu button[data-done]::after{content:" \\2713"}
.sc{display:grid;place-items:center;flex:none;width:24px;height:24px;border-radius:50%;background:#b3bac9;color:#fff}
.sc .ic{width:14px;height:14px;stroke-width:2.6}
.sc.ok{background:#14af6f}
.sc.bad{background:#f03338}
.sc.busy{background:#3b82f6}
.sc.wait{background:#f59e0b}
.sc.pur{background:#8b5cf6}
.card.vis{overflow:visible}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{padding:11px 16px;background:#f8f8fa;color:#6b7280;font-size:12px;font-weight:600;text-align:left;white-space:nowrap}
td{padding:13px 16px;border-top:1px solid var(--line-2);font-size:14px;vertical-align:middle}
td.w{overflow-wrap:anywhere}
tbody tr:hover{background:#fcfcfd}
td a{color:#2563eb;text-decoration:none}
td a:hover{text-decoration:underline}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.muted{color:var(--muted)}
.dim{display:block;margin-top:3px;color:var(--muted);font-size:12px}
.st{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px 0 8px;border-radius:13px;background:#f1f2f4;color:#4b5563;font-size:12.5px;font-weight:600;white-space:nowrap}
.st .ic{width:15px;height:15px}
.st.ok{background:#e8f7ee;color:#15803d}
.st.bad{background:#fdecec;color:#dc2626}
.st.busy{background:#e8f0fe;color:#2563eb}
.st.wait{background:#fff4e0;color:#b45309}
.st.pur{background:#f1ebfe;color:#7c3aed}
.sd{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#f1f2f4;color:#4b5563}
.sd .ic{width:17px;height:17px}
.sd.ok{background:#e8f7ee;color:#15803d}
.sd.bad{background:#fdecec;color:#dc2626}
.sd.busy{background:#e8f0fe;color:#2563eb}
.sd.wait{background:#fff4e0;color:#b45309}
.sd.pur{background:#f1ebfe;color:#7c3aed}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#9ca3af}
.dot.on{background:#22c55e}
.chip{display:inline-block;padding:2px 9px;border-radius:6px;background:#f1f2f4;color:#4b5563;font-size:12px;font-weight:500}
.chip.prod{background:#fdecec;color:#dc2626}
.chip.stg{background:#fff4e0;color:#b45309}
.chip.prev{background:#e8f0fe;color:#2563eb}
.pg{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 22px;border-top:1px solid var(--line-2);color:var(--muted);font-size:14px}
.pg .lk{display:flex;gap:16px}
.pg a{color:#2563eb;text-decoration:none}
.empty{padding:28px 22px;color:var(--muted);font-size:14px}
.jr{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;padding:16px 22px;border-top:1px solid var(--line-2)}
.ch+.jr{border-top:0}
.jr .tx{flex:1;min-width:160px}
.jr b{display:block;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.jr span.d{display:block;margin-top:2px;color:var(--muted);font-size:13px}
.jr .du{width:70px;color:var(--ink-2);font-size:14px}
.cnt2{color:var(--muted);font-size:14px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:12px 24px;padding:20px 22px;font-size:14px}
.kv dt{color:var(--muted)}
.kv dd{overflow-wrap:anywhere}
.page{text-align:center}
.signin{max-width:480px;margin:72px auto;padding:36px 32px;text-align:left}
.signin h1{font-size:26px}
.signin p{margin:12px 0 22px;color:var(--ink-2)}
.signin .ob{height:44px}
@media (max-width:900px){
.main{padding:24px 0 56px}
h1{font-size:28px}
.rt .dc{display:none}
}
@media (max-width:640px){
.tabs{gap:18px}
.app .in{height:56px}
}
.am{display:none}
.bars,.bars::before,.bars::after{display:block;width:20px;height:2px;border-radius:1px;background:currentColor}
.bars{position:relative}
.bars::before,.bars::after{content:"";position:absolute;left:0}
.bars::before{top:-6px}
.bars::after{top:6px}
.am[open] .bars{background:transparent}
.am[open] .bars::before{top:0;transform:rotate(45deg)}
.am[open] .bars::after{top:0;transform:rotate(-45deg)}
@media (min-width:901px) and (max-width:1023px){
.app .in{gap:24px!important}
.app .tabs{gap:20px!important;margin-left:0!important}
.app .rt{gap:14px!important}
}
@media (min-width:1024px) and (max-width:1100px){
body:not(.overview) .app .in{gap:24px!important}
body:not(.overview) .app .tabs{gap:20px!important;margin-left:0!important}
body:not(.overview) .app .rt{gap:14px!important}
}
@media (max-width:900px){
.am:not([open]) .amp{display:none}
.app .in{display:flex;flex-wrap:nowrap!important;width:100%!important;max-width:none!important;height:64px!important;min-height:0!important;margin:0!important;gap:18px!important;padding:0 var(--gutter)!important}
.app .brand{align-items:center;min-height:44px}
.in:has(.am)>.tabs,.in:has(.am)>.rt{display:none}
.app .in:not(:has(.am)) .rt .dc{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px}
.am{display:block;margin-left:auto}
.am summary{display:grid;place-items:center;width:44px;height:44px;margin-right:-10px;border-radius:10px;color:var(--ink);list-style:none;cursor:pointer}
.am summary::-webkit-details-marker{display:none}
.am summary:hover,.am[open] summary{background:#f1f2f4}
.amp{position:absolute;z-index:6;left:0;right:0;top:100%;display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 56px);max-height:calc(100dvh - 56px);overflow-y:auto;padding:8px max(16px,env(safe-area-inset-right)) 16px max(16px,env(safe-area-inset-left));border-bottom:1px solid var(--line);background:#fff;box-shadow:0 14px 28px rgba(15,20,29,.14)}
.amt,.amu{display:flex;flex-direction:column;gap:8px}
.amu{padding-top:12px;border-top:1px solid var(--line-2)}
.amu:first-child{padding-top:0;border-top:0}
.amp a,.amp button{display:flex;align-items:center;width:100%;min-height:44px;padding:0 12px;border:0;border-radius:10px;background:none;color:var(--ink);font:inherit;font-size:16px;text-align:left;text-decoration:none;cursor:pointer}
.amp a:hover,.amp button:hover{background:#f4f5f7}
.amp a.on{background:var(--orange-soft);font-weight:600}
.amw{padding:0 12px;color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.accts{gap:8px 16px}
.accts a,.accts strong{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;overflow-wrap:anywhere}
}
@media (max-width:640px){
.app .in{height:56px!important}
}
@media (max-width:900px),(pointer:coarse){
.mnu summary{width:44px;height:44px}
.mnu:not([open]) .menu{display:none}
.menu{top:48px;display:flex;flex-direction:column;gap:8px;min-width:200px;max-width:calc(100vw - 32px)}
.menu a,.menu button{display:flex;align-items:center;min-height:44px;padding:0 12px;font-size:16px}
.ob,.ch a,.lnk{min-height:44px}
.pg a{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px}
}
@media (max-width:640px){
.ph{flex-direction:column;align-items:stretch}
.ph>*{min-width:0}
.ph .ob,.ph form,.ph select,.ph input{width:100%}
.ch{flex-wrap:wrap;padding:12px 16px}
.pg{flex-wrap:wrap;padding:12px 16px}
.pg .lk{gap:8px}
.empty{padding:20px 16px}
.st{height:auto;min-height:26px;padding-top:3px;padding-bottom:3px;white-space:normal}
.kv{grid-template-columns:minmax(0,1fr);gap:4px 0;padding:16px}
.kv dd+dt{margin-top:12px}
.signin{margin:32px auto;padding:24px 20px}
.signin .ob{width:100%;justify-content:center}
}
`;

/** The signed-in header controls when accounts are on: a sign out form and, for an email account, a link to its settings. */
export interface DashboardChrome {
	csrf: string;
	settings: boolean;
}

export type AppTab = "overview" | "runs" | "agents" | "repositories" | "settings";

/** Who is looking and where: what the app header needs. tab is null on pages that are not a tab (sign in, errors). */
export interface Viewer {
	who?: string;
	chrome?: DashboardChrome;
	base?: string;
	tab?: AppTab | null;
}

const TAB_LABELS: [AppTab, string, string][] = [
	["overview", D.navOverview, ""],
	["runs", D.navRuns, "/runs"],
	["agents", D.navAgents, "/agents"],
	["repositories", D.navRepositories, "/repositories"],
	["settings", D.navSettings, "/settings"],
];

function tabLink(href: string, label: string, on: boolean): string {
	return `<a href="${e(href)}"${on ? ' class="on" aria-current="page"' : ""}>${e(label)}</a>`;
}

function userControls(v: Viewer, signOut: string): string {
	const who = v.who === undefined ? "" : e(D.signedInAs(v.who));
	const avatar = `<span class="usr" title="${who}">${icon("user")}<span class="sr">${who}</span></span>`;
	const settings = v.chrome?.settings ? `<a href="/account/settings" class="usr" title="${e(D.settings)}">${icon("user")}<span class="sr">${e(D.settings)}</span></a>` : avatar;
	if (v.chrome === undefined) return v.who === undefined ? "" : avatar;
	return `${settings}${signOut}`;
}

/** The menu below 900px: the tabs, Docs and the account controls in a no-script details panel (hidden on desktop). A header with only Docs has no menu. */
function appMenu(v: Viewer, tabLinks: string, signOut: string): string {
	if (tabLinks === "" && v.who === undefined && v.chrome === undefined) return "";
	const tabs = tabLinks === "" ? "" : `<nav class="amt" aria-label="${e(D.navLabel)}">${tabLinks}</nav>`;
	const who = v.who === undefined ? "" : `<p class="amw">${e(D.signedInAs(v.who))}</p>`;
	const account = v.chrome?.settings ? `<a href="/account/settings">${e(D.accountMenu)}</a>` : "";
	return (
		`<details class="am"><summary aria-label="${e(D.navMenu)}"><span class="bars"></span></summary><div class="amp">${tabs}` +
		`<div class="amu"><a href="${e(S.site.docsUrl)}" rel="noopener noreferrer">${e(D.docs)}</a>${who}${account}${signOut}</div></div></details>`
	);
}

function appHeader(v: Viewer): string {
	const base = v.base;
	const tabLinks = base === undefined ? "" : TAB_LABELS.map(([tab, label, path]) => tabLink(`${base}${path}`, label, v.tab === tab)).join("");
	const tabs = tabLinks === "" ? "" : `<nav class="tabs" aria-label="${e(D.navLabel)}">${tabLinks}</nav>`;
	const signOut =
		v.chrome === undefined
			? ""
			: `<form method="post" action="/account/logout"><input type="hidden" name="csrf" value="${e(v.chrome.csrf)}"><button type="submit">${e(D.signOut)}</button></form>`;
	return (
		`<header class="app"><div class="in">${brandLink("/app", false)}${tabs}` +
		`<div class="rt"><a class="dc" href="${e(S.site.docsUrl)}" rel="noopener noreferrer">${e(D.docs)}</a>${userControls(v, signOut)}</div>${appMenu(v, tabLinks, signOut)}</div></header>`
	);
}

/** A page of the dashboard chrome: the app header with the five tabs around main, the shared CSS plus the page's own. */
export interface AppPageOptions {
	title: string;
	bodyClass: string;
	main: string;
	viewer: Viewer;
	init?: PageInit;
	/** Extra CSS appended after the shared dashboard CSS. */
	css?: string;
	/** Icons beyond the shared set and EXTRA_ICONS. */
	icons?: Readonly<Record<string, string>>;
	/** One inline script, pinned by hash. */
	script?: string;
	connect?: boolean;
	/** The page shows GitHub avatars: img-src is opened to GitHub's avatar hosts. */
	avatars?: boolean;
	/** Whether forms may post back to the hub; default yes. */
	forms?: boolean;
}

/** GitHub serves profile pictures from github.com (redirecting) and avatars.githubusercontent.com. */
const AVATAR_HOSTS = ["https://github.com", "https://avatars.githubusercontent.com"] as const;

export function appPage(o: AppPageOptions): Promise<Response> {
	return shellResponse(
		{
			title: o.title,
			bodyClass: o.bodyClass,
			css: CSS + (o.css ?? ""),
			body: `${appHeader(o.viewer)}<main class="main ${o.bodyClass}">${o.main}</main>`,
			icons: { ...EXTRA_ICONS, ...o.icons },
			script: o.script,
			...(o.connect ? { connect: true } : {}),
			...(o.avatars ? { imgSrc: AVATAR_HOSTS } : {}),
			...(o.forms === undefined ? {} : { forms: o.forms }),
		},
		o.init ?? {},
	);
}

/** A page of the dashboard chrome around bodyHtml, used by the sign-in and error pages. */
export function dashboardPage(title: string, bodyHtml: string, init: PageInit & { who?: string; chrome?: DashboardChrome } = {}): Promise<Response> {
	const { who, chrome, ...rest } = init;
	const v: Viewer = { ...(who === undefined ? {} : { who }), ...(chrome === undefined ? {} : { chrome }) };
	return appPage({ title, bodyClass: "plain", main: bodyHtml, viewer: v, init: rest, forms: chrome !== undefined });
}

export function signInPage(): Promise<Response> {
	return dashboardPage(
		D.signInTitle,
		`<section class="card signin"><h1>${e(D.signInTitle)}</h1><p>${e(D.signInIntro)}</p><a class="ob dk" href="/app/login">${icon("github", "gh")}${e(D.signInButton)}</a></section>`,
	);
}

export function noInstallationPage(cookies: string[] = [], chrome?: DashboardChrome): Promise<Response> {
	return dashboardPage(
		D.noInstallationTitle,
		`<section class="card signin"><h1>${e(D.noInstallationTitle)}</h1><p>${e(D.noInstallationBody)}</p><a class="ob dk" href="/start">${e(D.noInstallationButton)}</a></section>`,
		{ cookies, ...(chrome ? { chrome } : {}) },
	);
}

export function notFoundPage(): Promise<Response> {
	return dashboardPage(
		D.notFoundTitle,
		`<section class="card signin"><h1>${e(D.notFoundTitle)}</h1><p>${e(D.notFoundBody)}</p><a class="ob" href="/app">${e(D.signInAgain)}</a></section>`,
		{ status: 404 },
	);
}

interface Units {
	minutes: (n: number) => string;
	hours: (n: number) => string;
	days: (n: number) => string;
}

/** The whole minutes, hours or days between since and now (never negative) in the given words; zero is what reads for under a minute. */
function elapsedText(since: number, now: number, zero: string, units: Units): string {
	const minutes = Math.max(0, Math.floor((now - since) / 60_000));
	if (minutes >= 1440) return units.days(Math.floor(minutes / 1440));
	if (minutes >= 60) return units.hours(Math.floor(minutes / 60));
	return minutes >= 1 ? units.minutes(minutes) : zero;
}

/** "10 min ago" style text with the exact UTC time in the title. */
export function agoHtml(ms: number | null, now: number, minutesText: (n: number) => string = D.ago.minutes): string {
	if (ms === null) return e(D.none);
	const iso = new Date(ms).toISOString();
	const text = elapsedText(ms, now, D.ago.justNow, { ...D.ago, minutes: minutesText });
	return `<time datetime="${iso}" title="${iso.slice(0, 16).replace("T", " ")} UTC">${e(text)}</time>`;
}

/** "Aug 12, 2026" in UTC. */
export function dateOf(ms: number): string {
	return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "41s", "2m 08s", "1h 02m": the way the dashboard writes a duration. */
export function durationText(ms: number | null): string {
	if (ms === null) return D.none;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const pad = (n: number) => String(n).padStart(2, "0");
	if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
	return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

export function badge(state: string): string {
	const look = stateLook(state);
	return `<span class="st ${look.tone}">${icon(look.icon)}${e(D.state[state] ?? state)}</span>`;
}

/** A filled round state mark: green tick, red cross, grey dots and so on; the state's name is the title and screen reader text. */
export function statusCircle(state: string): string {
	const look = stateLook(state);
	const label = D.state[state] ?? state;
	return `<span class="sc ${look.tone}" title="${e(label)}">${icon(look.glyph)}<span class="sr">${e(label)}</span></span>`;
}

/** The repository's own name without its owner, for narrow columns. */
export function shortRepo(fullName: string | null): string {
	if (fullName === null) return D.unknownRepo;
	return fullName.slice(fullName.indexOf("/") + 1);
}

/** How long a time span is, in words ("2 hours"), for sentences like "offline for 2 hours". */
export function spanText(since: number, now: number): string {
	return elapsedText(since, now, D.span.lessThanMinute, D.span);
}

/**
 * The three-dots menu of a table row: a native details element with links only to places that exist.
 * copyPath adds a "copy link" button that needs the page script and stays hidden without it.
 */
export function rowMenu(items: readonly (readonly [string, string])[], copyPath: string | null): string {
	const links = items.map(([href, label]) => `<a href="${e(href)}" rel="noopener noreferrer">${e(label)}</a>`).join("");
	const copy = copyPath === null ? "" : `<button type="button" data-copy="${e(copyPath)}" hidden>${e(D.menu.copyLink)}</button>`;
	return `<details class="mnu"><summary aria-label="${e(D.menu.label)}">${icon("ellipsis")}</summary><div class="menu">${links}${copy}</div></details>`;
}

/** The marker of a data-swap element whose content can still change: any of the run states has not reached its end. */
export function activeAttr(states: Iterable<string>): string {
	const final: ReadonlySet<string> = TERMINAL;
	for (const s of states) if (!final.has(s)) return " data-active";
	return "";
}

/**
 * The one script of the dashboard pages, pinned by hash. Forms marked data-auto submit when a select changes (they carry a noscript
 * button), data-copy buttons copy their text (an absolute path is made absolute) and the runs banner (data-newer) asks the hub every
 * 30 seconds how many runs matching the filter form are newer than data-after. The first answer also reveals the data-live pill and
 * the banner shows once there is something new; closing it waits for runs newer still.
 * Elements marked data-swap refresh themselves: the script fetches the page again and replaces their content with the fresh copy
 * of the element with the same data-swap name, every 4 seconds while any of them is data-active and otherwise every data-idle
 * milliseconds (never when that is missing). A swap waits while a menu is open or focus is inside the element, keeps the table's
 * scroll position, and makes a data-follow banner count from the fresh newest run, as the table now shows it.
 */
export const PAGE_SCRIPT = `
{
const wire = (root) => {
  for (const b of root.querySelectorAll("[data-copy]")) {
    b.hidden = false;
    b.addEventListener("click", () => {
      const v = b.dataset.copy;
      navigator.clipboard.writeText(v.startsWith("/") ? location.origin + v : v).then(() => { b.dataset.done = "1"; });
    });
  }
};
for (const form of document.querySelectorAll("form[data-auto]")) form.addEventListener("change", () => form.requestSubmit());
wire(document);
for (const n of document.querySelectorAll("[data-newer]")) {
  const form = document.getElementById("runs-filter");
  const poll = () => {
    if (document.hidden) return;
    const q = new URLSearchParams(new FormData(form));
    q.set("after", n.dataset.after);
    fetch(n.dataset.newer + "?" + q, { credentials: "same-origin", headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        for (const l of document.querySelectorAll("[data-live]")) l.hidden = false;
        n.dataset.latest = d.newest;
        if (d.count > 0) {
          n.querySelector("[data-count]").textContent = (d.count === 1 ? n.dataset.one : n.dataset.many).replace("{n}", d.count);
          n.hidden = false;
        }
      })
      .catch(() => {});
  };
  for (const x of n.querySelectorAll("[data-dismiss]")) x.addEventListener("click", () => { n.hidden = true; n.dataset.after = n.dataset.latest; });
  poll();
  setInterval(poll, 30000);
}
const targets = [...document.querySelectorAll("[data-swap]")];
if (targets.length > 0) {
  const holds = (el) => {
    const a = document.activeElement;
    if (a !== null && el.contains(a) && !a.matches("summary.jr2")) return true;
    return [...el.querySelectorAll("details[open]")].some((d) => d.querySelector(":scope > summary.jr2") === null);
  };
  const refresh = async () => {
    const r = await fetch(location.href, { credentials: "same-origin", headers: { accept: "text/html" } });
    if (!r.ok || r.redirected) throw new Error();
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    for (const el of targets) {
      const fresh = doc.querySelector('[data-swap="' + el.dataset.swap + '"]');
      if (fresh === null) continue;
      el.toggleAttribute("data-active", fresh.hasAttribute("data-active"));
      if (fresh.dataset.idle) el.dataset.idle = fresh.dataset.idle;
      else delete el.dataset.idle;
      if (holds(el)) continue;
      const scrolls = [...el.querySelectorAll(".scroll")].map((s) => s.scrollLeft);
      const key = (d, i) => (d.querySelector(":scope > summary b") ? d.querySelector(":scope > summary b").textContent : "#" + i);
      const opened = new Set([...el.querySelectorAll("details")].filter((d) => d.open).map(key));
      const checks = [...el.querySelectorAll("input[type=checkbox]")].map((c) => c.checked);
      el.replaceChildren(...fresh.childNodes);
      el.querySelectorAll("details").forEach((d, i) => { if (opened.has(key(d, i))) d.open = true; });
      el.querySelectorAll("input[type=checkbox]").forEach((c, i) => { if (i < checks.length) c.checked = checks[i]; });
      el.querySelectorAll(".scroll").forEach((s, i) => { s.scrollLeft = scrolls[i] || 0; });
      wire(el);
    }
    const follow = doc.querySelector("[data-follow]");
    const banner = document.querySelector("[data-follow]");
    if (follow !== null && banner !== null && follow.dataset.after !== banner.dataset.after) {
      banner.dataset.after = banner.dataset.latest = follow.dataset.after;
      banner.hidden = true;
    }
    for (const l of document.querySelectorAll("[data-live]")) l.hidden = false;
  };
  const next = () => {
    if (targets.some((t) => t.hasAttribute("data-active"))) return 2000;
    const idle = Math.min(...targets.map((t) => Number(t.dataset.idle || Infinity)));
    return Number.isFinite(idle) ? idle : 0;
  };
  const loop = () => {
    const wait = next();
    if (wait === 0) return;
    setTimeout(async () => {
      if (!document.hidden) await refresh().catch(() => {});
      loop();
    }, wait);
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh().catch(() => {}); });
  loop();
}
}
`;

export function branchLabel(ref: string): string {
	return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

export function repoText(run: RunListRow): string {
	return run.repo_name ?? D.unknownRepo;
}

export function runHref(base: string, run: RunListRow): string {
	return `${base}/runs/${encodeURIComponent(run.run_id)}`;
}

export function accountNav(accounts: readonly InstallationRow[], currentId: number): string {
	if (accounts.length < 2) return "";
	const items = accounts.map((a) => `<li>${a.id === currentId ? `<strong>${e(a.account_login)}</strong>` : `<a href="/app/${a.id}">${e(a.account_login)}</a>`}</li>`);
	return `<ul class="accts" aria-label="${e(D.accounts)}">${items.join("")}</ul>`;
}

/** The viewer of an installation's page: who is signed in, the installation's URL base and the active tab. */
export function viewerOf(v: { login: string; chrome?: DashboardChrome; account: InstallationRow }, tab: AppTab | null): Viewer {
	return { who: v.login, base: `/app/${v.account.id}`, tab, ...(v.chrome ? { chrome: v.chrome } : {}) };
}

export function initOf(v: { cookies?: string[] }): PageInit {
	return v.cookies ? { cookies: v.cookies } : {};
}

/** The page title block: h1, subtitle and optional controls on the right (already escaped HTML). */
export function pageHead(title: string, subtitle: string, controls = ""): string {
	return `<div class="ph"><div><h1>${e(title)}</h1><p class="sub">${e(subtitle)}</p></div>${controls}</div>`;
}

export function agoPlain(ms: number, now: number): string {
	return elapsedText(ms, now, D.ago.justNow, D.ago);
}
