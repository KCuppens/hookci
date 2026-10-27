import type { StatusComponent } from "../db/status";
import type { ComponentSummary, DayBar, Health, Incident, StatusSummary } from "../status-summary";
import { S } from "../strings";
import { escapeHtml } from "./layout";
import { icon, legalFooter, shellResponse, siteNav } from "./shell";
import { TRACED_ICONS } from "./status-icons";

// The public status page: header, overall banner, one card with a service row per component and
// 30 day bars, and the incident history card. Static markup, no script; the shell adds the CSP.

const T = S.status;
const e = escapeHtml;

const CSS = `
.p-status{--nh:87px;--ls:.129;--ly:0px;--ry:0px;--nfs:16px;--ph:43px;--pw:14.25px;--ffs:14.5px;--fp:16px;--g10:24px;background:light-dark(#fafafa,#161b22);will-change:opacity}
.p-status .nav{background:light-dark(#fdfdfd,#161b22);border-bottom:1px solid light-dark(#e8eaef,#37393d)}
.p-status .links{gap:43px;margin-right:45px}
.p-status .links a{position:relative;top:0;letter-spacing:-.03em;color:light-dark(#5b657c,#8b95ae)}
.p-status .links a:nth-child(1){left:2.4px;letter-spacing:-.035em}
.p-status .links a:nth-child(2){left:2px}
.p-status .links a:nth-child(3){left:.95px;letter-spacing:-.0255em}
.p-status .pill .ic{width:20.6px;height:20.6px;stroke:currentColor;fill:none;stroke-width:2}
.p-status .pill{gap:7px;padding:2px 16px 0 14.5px;border-color:light-dark(#e9ebf0,#36383c);border-radius:13px;color:light-dark(#080b16,#f9ffff);font-weight:500;letter-spacing:-.05em;box-shadow:none}
.p-status .pill span{position:relative;top:-.3px}
.wrap{position:relative;z-index:1;width:calc(100% - 2 * var(--gutter));max-width:var(--app-w);margin:0 auto;padding-bottom:41.9px}
.hd{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:39px 8px 0 6.9px}
.hd h1{margin:1.1px 0 0 -1.2px;font-size:51px;line-height:53.35px;font-weight:600;letter-spacing:-.04em;color:light-dark(#050b15,#f5ffff)}
.hd .sub{position:relative;left:.9px;margin-top:8.8px;font-size:19px;line-height:1.4;letter-spacing:-.017em;word-spacing:1px;color:light-dark(#4e566f,#8b95b0)}
.upd{position:relative;left:1.7px;min-width:235px;padding-top:27px;text-align:left;white-space:nowrap}
.upd span{display:block;margin-top:-1.7px;font-size:15px;line-height:20px;letter-spacing:-.0025em;color:light-dark(#646a7f,#8d95aa)}
.upd span:not(.at){position:relative;left:-1px}
.upd .at{margin:1.25px 0 0 -.5px;font-size:16px;font-weight:500;line-height:24px;letter-spacing:-.015em;color:light-dark(#545c74,#8c95af)}
.banner{display:flex;align-items:center;gap:30px;margin:34.1px -1px 0;min-height:119px;padding:0 33px 0 32.5px;border:2px solid var(--bd);border-radius:14px;background:var(--bg)}
.banner .gl{display:grid;place-items:center;flex:none;position:relative;top:-1px;width:57px;height:57px;margin:0 .5px;border-radius:50%;background:var(--gl);color:#fff;box-shadow:0 0 0 1px light-dark(#fff,#2a2924)}
.banner .gl .ic{width:34px;height:34px;stroke-width:2.4}
.banner .tx{flex:1;min-width:0}
.banner h2{margin-top:1px;font-size:27.25px;line-height:1.2;font-weight:700;letter-spacing:-.035em;color:var(--ti)}
.banner p{position:relative;top:1.3px;margin-top:1px;font-size:18px;line-height:1.4;letter-spacing:-.01em;color:light-dark(#535f74,#8896ac)}
.follow{display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:none;height:49px;padding:0 18px 0 16px;border:1px solid light-dark(#dfe5ea,#3a3e41);border-radius:10px;background:light-dark(#fff,#161b22);color:light-dark(#050811,#f8ffff);font-size:16px;font-weight:500;letter-spacing:-.045em;text-decoration:none;box-shadow:0 1px 2px light-dark(rgba(15,20,29,.04),rgba(0,0,0,0.1))}
.follow:hover{background:light-dark(#fcfcfd,#161b22)}
.follow .ic{width:24px;height:24px;stroke-width:2}
.follow span{position:relative;top:-.45px;left:.85px}
.b-operational{--bg:light-dark(#f0f8f4,#1d201e);--bd:light-dark(#e3f1eb,#333836);--gl:#24b070;--sh:rgba(38,186,118,.28);--ti:light-dark(#00241a,#779d8f)}
.b-degraded{--bg:light-dark(#fff8e9,#161b22);--bd:light-dark(#f6e8c6,#494029);--gl:#eab937;--sh:rgba(234,185,55,.3);--ti:light-dark(#6b4a05,#b48f55)}
.b-outage{--bg:light-dark(#fef3f2,#211e1e);--bd:light-dark(#f7dbd8,#52403e);--gl:light-dark(#e5484d,#fe5f61);--sh:rgba(229,72,77,.28);--ti:light-dark(#7a1d20,#dd7873)}
.b-none{--bg:light-dark(#f4f5f7,#1e2022);--bd:light-dark(#e6e8ec,#383a3f);--gl:#9aa1ad;--sh:rgba(154,161,173,.3);--ti:light-dark(#0f141d,#f8ffff)}
.card{margin:22px -1px 0;padding:0 1px;border:1px solid light-dark(#e9edf1,#34373b);border-radius:14px;background:light-dark(#fefefe,#161b22);box-shadow:0 1px 3px light-dark(rgba(15,20,29,.025),rgba(0,0,0,0.062))}
.card+.card{margin-top:27px}
.ch{display:flex;align-items:center;justify-content:space-between;gap:16px}
.ch h2{position:relative;top:var(--h2t);font-size:25px;line-height:1.2;font-weight:700;letter-spacing:-.035em;color:light-dark(#030713,#f5ffff)}
.ch span{position:relative;top:var(--spt);font-size:16.25px;letter-spacing:-.0375em;color:light-dark(#5d6880,#8a96af)}
.svc{--h2t:1.05px;--spt:1.55px}
.inc{--h2t:.5px;--spt:.55px}
.svc .ch{height:77px;padding:2px 24.3px 0 26px;border-bottom:1px solid light-dark(#e9edf1,#34373b)}
.rows{list-style:none}
.row{display:grid;grid-template-columns:58px minmax(0,1fr);column-gap:31px;align-content:start;box-sizing:border-box;height:var(--rh,162px);margin:0 16px;padding:22px 12.65px 0 15.5px;border-bottom:1px solid light-dark(#e9ecf2,#35373c)}
.row:last-child{border-bottom:0}
.row:nth-child(1){--i:1px;--sd:1.7px;--up:1.65px;--l:1.25px;--nt:1px;--nx:-.85px;--ns:-.0175em;--dy:2.1px;--dx:-.57px;--ds:-.005em}
.row:nth-child(2){--rh:163px;--d:0px;--b:1px;--i:0px;--sd:3.55px;--up:2.5px;--l:1.25px;--nt:.7px;--nx:-.64px;--ns:-.0125em;--dy:2px;--dx:-.76px;--ds:-.0038em}
.row:nth-child(3){--rh:173px;--p:0px;--d:3px;--b:2px;--l:1.9px;--i:0px;--sd:4.8px;--up:5.4px;--nt:1.5px;--nx:-.3px;--ns:-.0175em;--dy:2.9px;--dx:-.37px;--ds:-.01em}
.row .tl{display:grid;place-items:center;width:58px;height:58px;margin-top:var(--i,1px);border-radius:50%;background:light-dark(#f1f2f4,#212325);color:light-dark(#000,#fff)}
.row .tl .ic{width:32px;height:32px;stroke-width:1.75}
.rt{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding-top:var(--p,0px)}
.rn{position:relative;top:var(--nt);left:var(--nx);font-size:19.5px;line-height:22px;font-weight:600;letter-spacing:var(--ns);color:light-dark(#03050b,#f9ffff)}
.rd{position:relative;top:var(--dy);left:var(--dx);margin-top:calc(3px + var(--d,0px));font-size:15.75px;line-height:22px;letter-spacing:var(--ds);color:light-dark(#5a627a,#8c95ae)}
.rs{display:flex;align-items:flex-start;gap:19.7px;flex:none;line-height:22px}
.hs{display:inline-flex;align-items:center;gap:9.3px;margin-top:var(--sd,0px);font-size:16px;font-weight:500;letter-spacing:-.025em;line-height:22px}
.dot{width:18px;height:18px;border-radius:50%;background:var(--c)}
.hs{color:var(--t)}
.up{margin-top:var(--up,0px);font-size:15.25px;line-height:22px;letter-spacing:-.015em;color:light-dark(#636a7f,#8d95aa);white-space:nowrap}
.h-operational{--c:#26ba76;--t:light-dark(#119253,#35a968)}
.h-degraded{--c:#eab937;--t:light-dark(#a8740d,#c18b31)}
.h-outage{--c:light-dark(#e5484d,#fe5f61);--t:light-dark(#c0262b,#fb625c)}
.h-none{--c:#c4c8d0;--t:light-dark(#656c7a,#9199a8)}
.bars{display:flex;justify-content:space-between;margin:calc(13px + var(--b,0px)) 6.8px 0 0;height:27px;list-style:none}
.b{position:relative;flex:none;width:13.85px;border-radius:3px;background:light-dark(#e6e8ec,#2c2d30);transform:translateY(1.85px)}
@supports (width:calc(sibling-index()*1px)){.b{translate:calc((.00555 * sibling-index() * sibling-index() - .232 * sibling-index() + .777) * 1px)}}
.b.h-operational{background:#4ac68f}
.b.h-degraded{background:light-dark(#ebb935,#564211)}
.b.h-outage{background:#e5484d}
.b.h-none{background:light-dark(#e6e8ec,#2c2d30)}
.b.part{background:linear-gradient(#4ac68f,light-dark(#ebb935,#564211))}
.rl{display:flex;justify-content:space-between;margin-top:calc(11px + var(--l,0px));font-size:15px;line-height:20px;letter-spacing:-.025em;color:light-dark(#626a7e,#8c96aa)}
.rl span:first-child{margin-left:-.9px}
.rl span:last-child{position:relative;left:-1.2px;letter-spacing:-.0585em}
.inc .ch{padding:22px 24.3px 0 26px}
.inc .ch span{left:-.24px;letter-spacing:-.032em}
.inc .ch h2{font-size:25px;letter-spacing:-.03em}
.empty{display:flex;align-items:center;gap:26.4px;margin:23px 24px 22.5px;min-height:106px;padding:0 26px;border-radius:12px;background:light-dark(#f6f8fa,#161b22)}
.empty>div{padding-top:1px}
.incs{list-style:none}
.incs .empty+.empty{margin-top:0}
.empty .tl{display:grid;place-items:center;flex:none;width:58px;height:58px;border-radius:50%;background:light-dark(#eef0f4,#242527);color:light-dark(#38435d,#8896b3)}
.empty .tl .ic{width:32px;height:32px;stroke-width:1.75}
.empty strong{display:block;font-size:18px;line-height:24px;font-weight:600;letter-spacing:-.025em;color:light-dark(#03050a,#f9ffff)}
.empty p{position:relative;left:.3px;margin-top:0;font-size:14.75px;line-height:24px;letter-spacing:.0057em;color:light-dark(#5c6377,#8d95aa)}
.ft{display:flex;align-items:center;justify-content:space-between;margin-top:calc(var(--g10) + 1.6px);padding-left:8px}
.ft .foot{margin-top:0}
.pw{display:inline-flex;align-items:center;gap:10px;font-size:15px;line-height:16px;letter-spacing:-.045em;color:light-dark(#636a7e,#8d95a9);text-decoration:none}
.pw:hover{color:var(--ink)}
.pw .ic{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.8}
.fl{justify-content:flex-end;padding-right:10px}
.fl a{position:relative;padding:0 16px;font-size:14.5px;letter-spacing:-.0407em;color:light-dark(#646a7e,#8d95a9)}
.fl a:nth-child(1){letter-spacing:-.041em}
.fl a:nth-child(2){letter-spacing:-.0375em}
.fl a:nth-child(3){letter-spacing:-.03em}
.fl a:first-child{padding-left:0}
.fl a:last-child{padding-right:0}
.fl a+a{border-left:0}
.fl a+a::before{content:"";position:absolute;left:-2px;top:50%;width:3px;height:3px;margin-top:-1px;border-radius:50%;background:#6b7280}
@media (max-width:900px){
.p-status{--nh:64px;--ls:.105;--ph:40px}
.hd{flex-direction:column;gap:16px;padding:24px 4px 0}
.hd h1{font-size:34px}
.hd .sub{font-size:16px}
.upd{padding-top:0}
.banner{flex-wrap:wrap;gap:16px;margin-top:24px;padding:20px}
.banner .gl{width:48px;height:48px}
.banner h2{font-size:21px}
.banner p{font-size:15.5px}
.follow{width:100%}
.svc .ch,.inc .ch{padding:0 18px}
.inc .ch{padding-top:20px}
.ch h2,.inc .ch h2{font-size:20px}
.svc .ch{height:60px}
.row{grid-template-columns:44px minmax(0,1fr);column-gap:14px;margin:0 8px;padding:20px 10px 20px 10px}
.row .tl{width:44px;height:44px}
.row .tl .ic{width:22px;height:22px}
.rt{flex-direction:column;gap:10px}
.rn{font-size:17px}
.rd{font-size:14.5px;line-height:20px}
.rs{gap:14px}
.hs{font-size:14.5px}
.dot{width:12px;height:12px}
.up{font-size:13.5px}
.row{height:auto;padding-bottom:20px}
.bars{gap:1px;height:24px;margin:14px 0 0}
.b{flex:1;width:auto;min-width:0;border-radius:2px}
.rl{font-size:13px}
.empty{flex-direction:column;align-items:flex-start;gap:14px;margin:18px 14px 14px;padding:20px}
.empty strong{font-size:17px}
.empty p{font-size:15px}
.ft{flex-direction:column;align-items:center;gap:14px;padding-left:0}
.pw{white-space:nowrap}
.fl{justify-content:center;padding-right:0}
}
@media (max-width:900px){
.upd{min-width:0;white-space:normal}
.hd h1,.hd .sub,.banner p,.rn,.rd,.empty p,.empty strong{overflow-wrap:anywhere}
.b{translate:none}
.pw{min-height:44px;white-space:normal}
.fl a{padding:0 12px}
.fl a+a::before{left:4px}
}
`;

const ICONS: Record<string, string> = {
	...TRACED_ICONS,
	bang: `<path d="M12 5.5v8.5M12 18.4v.01"/>`,
	cross: `<path d="m7 7 10 10M17 7 7 17"/>`,
	dash: `<path d="M6.5 12h11"/>`,
};

const BANNER_GLYPH: Record<Health, string> = { operational: "tick", degraded: "bang", outage: "cross", none: "dash" };
const COMPONENT_GLYPH: Record<StatusComponent, string> = { api: "stack", agents: "laptop", logs: "doc" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-19" as "Oct 19, 2026". */
function formatDay(day: string): string {
	const [year, month, date] = day.split("-");
	return `${MONTHS[Number(month) - 1]} ${Number(date)}, ${year}`;
}

/** Epoch milliseconds as "Oct 19, 2026 10:24 PM (UTC)". */
function formatUpdated(ms: number): string {
	const d = new Date(ms);
	const hour = d.getUTCHours();
	const minute = String(d.getUTCMinutes()).padStart(2, "0");
	return `${formatDay(d.toISOString().slice(0, 10))} ${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"} (UTC+0)`;
}

function incidentItem(i: Incident): string {
	return (
		`<li class="empty"><span class="tl">${icon(COMPONENT_GLYPH[i.component])}</span><div>` +
		`<strong>${e(T.components[i.component].name)}</strong><p>${e(T.dayFailed(formatDay(i.day), i.failed, i.total))}</p></div></li>`
	);
}

function incidentPanel(incidents: Incident[]): string {
	if (incidents.length > 0) return `<ul class="incs">${incidents.map(incidentItem).join("")}</ul></section>`;
	return `<div class="empty"><span class="tl">${icon("notebook")}</span><div><strong>${e(T.noIncidents)}</strong><p>${e(T.noIncidentsText)}</p></div></div></section>`;
}

function barItem(bar: DayBar): string {
	let text: string = T.noData;
	if (bar.health === "operational") text = T.dayPassed(formatDay(bar.day), bar.total);
	else if (bar.health !== "none") text = T.dayFailed(formatDay(bar.day), bar.total - bar.ok, bar.total);
	return `<li class="b h-${bar.health}${bar.recovered ? " part" : ""}" title="${e(text)}"><span class="sr">${e(text)}</span></li>`;
}

function serviceRow(c: ComponentSummary): string {
	const copy = T.components[c.component];
	return (
		`<li class="row"><span class="tl">${icon(COMPONENT_GLYPH[c.component])}</span><div>` +
		`<div class="rt"><div><h3 class="rn">${e(copy.name)}</h3><p class="rd">${e(copy.description)}</p></div>` +
		`<div class="rs"><span class="hs h-${c.health}"><i class="dot"></i>${e(T.health[c.health])}</span><span class="up">${e(T.uptime(c.uptime))}</span></div></div>` +
		`<ul class="bars">${c.bars.map(barItem).join("")}</ul>` +
		`<div class="rl"><span>${e(T.windowStart)}</span><span>${e(T.windowEnd)}</span></div></div></li>`
	);
}

/** The public status page for a summary of the recorded health checks. */
export function statusPage(summary: StatusSummary): Promise<Response> {
	const banner = T.banner[summary.overall];
	const href = e(S.site.releasesUrl);
	const stamp =
		summary.lastCheckedAt === null
			? e(T.noChecksYet)
			: `<time datetime="${new Date(summary.lastCheckedAt).toISOString()}">${e(formatUpdated(summary.lastCheckedAt))}</time>`;
	const pill = `<a class="pill ico" href="${href}" rel="noopener noreferrer">${icon("bell")}<span>${e(T.followNav)}</span></a>`;
	const button = `<a class="follow" href="${href}" rel="noopener noreferrer">${icon("bell")}<span>${e(T.followButton)}</span></a>`;
	const body =
		`${siteNav(pill)}<main class="wrap">` +
		`<div class="hd"><div><h1>${e(T.title)}</h1><p class="sub">${e(T.subtitle)}</p></div><div class="upd"><span>${e(T.lastUpdated)}</span><p class="at">${stamp}</p></div></div>` +
		`<section class="banner b-${summary.overall}" role="status"><span class="gl">${icon(BANNER_GLYPH[summary.overall])}</span>` +
		`<div class="tx"><h2>${e(banner.title)}</h2><p>${e(banner.text)}</p></div>${button}</section>` +
		`<section class="card svc" aria-labelledby="svc-h"><div class="ch"><h2 id="svc-h">${e(T.servicesHeading)}</h2><span>${e(T.windowLabel)}</span></div>` +
		`<ul class="rows">${summary.components.map(serviceRow).join("")}</ul></section>` +
		`<section class="card inc" aria-labelledby="inc-h"><div class="ch"><h2 id="inc-h">${e(T.incidentsHeading)}</h2><span>${e(T.incidentsWindow)}</span></div>` +
		incidentPanel(summary.incidents) +
		`<div class="ft"><a class="pw" href="${e(S.site.githubUrl)}" rel="noopener noreferrer">${e(T.poweredBy)}${icon("ext")}</a>${legalFooter(" fl")}</div></main>`;
	return shellResponse({ title: T.title, bodyClass: "p-status", css: CSS, body, icons: ICONS, forms: false });
}
