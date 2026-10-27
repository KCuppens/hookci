import type { InstallProgress } from "../db/install-progress";
import { S } from "../strings";
import { FLOW_ICONS } from "./flow-icons";
import { escapeHtml } from "./layout";
import { icon, legalFooter, shellResponse, siteNav } from "./shell";

// The pages that follow the GitHub App install: setup checklist, not-an-admin notice, permissions
// updated and the installation picker. One card, one stylesheet, shared by all four.

const T = S.flow.installed;
const e = escapeHtml;

export interface InstalledView {
	installationId: number;
	accountLogin: string;
	/** GitHub's account_type for the installation, "User" or "Organization". */
	accountType: string;
	pairToken: string;
	hubOrigin: string;
	/** LATEST_AGENT_VERSION; empty until the first release, when /install has nothing to download. */
	latestAgentVersion: string;
	expiresInMinutes: number;
	/** What the hub knows about each setup step; drives the checkmarks and the repository chips. */
	progress: InstallProgress;
	/** Set-Cookie values; include the session that lets this browser poll /start/status. */
	cookies: string[];
}

const CSS = `
.p-flow{background:light-dark(#fbfbfb,#161b22);font-weight:450;will-change:opacity;--nh:90px;--ls:.14;--ly:0px;--nfs:16px;--bww:129.8;--bgap:13.7;--bwy:11.4}
.p-flow .bg{background:none}
.p-flow .nav{background:light-dark(#fff,#161b22);border-bottom:1px solid light-dark(#eceef2,#34363a)}
.p-flow .links{gap:47px;margin-right:66px;position:relative;top:4px;letter-spacing:-.03em}
.p-flow .links a:nth-child(1){color:light-dark(#58637d,#8995b2)}
.p-flow .links a:nth-child(2){font-size:17px;font-weight:400;color:light-dark(#4a5674,#8795b6)}
.p-flow .links a:nth-child(3){font-size:16.5px;letter-spacing:0;color:light-dark(#5c6780,#8a95b0)}
.acct{display:grid;place-items:center;width:54px;height:54px;border:1px solid light-dark(#e3e6ee,#3a3c40);border-radius:50%;background:light-dark(#fff,#161b22);color:light-dark(#636a7f,#8c95ab)}
.acct .ic{width:30.7px;height:30.7px;stroke-width:1.7;position:relative;left:-1px;top:1.2px}
.card{position:relative;left:1px;z-index:2;width:min(var(--app-w),100% - 2 * var(--gutter));margin:28px auto 0;padding:32px 29px 0 31px;border:1px solid light-dark(#e5e7eb,#393b3f);border-radius:16px;background:light-dark(#fefefe,#161b22);box-shadow:0 1px 2px light-dark(rgba(15,20,29,.02),rgba(0,0,0,0.05)),0 12px 36px light-dark(rgba(15,20,29,.035),rgba(0,0,0,0.088))}
.card.narrow{width:min(704px,100% - 2 * var(--gutter));padding-bottom:32px}
.hd{display:flex;align-items:flex-start;gap:28px}
.seal{display:grid;place-items:center;flex:none;width:82px;height:82px;border-radius:50%;background:light-dark(#e4f4e9,#242625);color:#20ae53}
.seal .ic{width:51px;height:51px;stroke-width:3.2}
.card:not(.narrow) .seal.tone-ok .ic{position:relative;left:1.3px;top:-.7px}
.seal.tone-info{background:light-dark(#e8eefc,#262729);color:light-dark(#3b63c9,#6591fc)}
.seal.tone-info .ic{width:40px;height:40px;stroke-width:1.8}
.seal.tone-warn{background:light-dark(#fff1ea,#23201f);color:var(--orange)}
.seal.tone-warn .ic{width:40px;height:40px;stroke-width:1.8}
.hd .ttl{flex:1;min-width:0;margin-top:2px}
.eyebrow{display:block;margin-left:.6px;font-size:14.75px;line-height:20px;font-weight:500;letter-spacing:0;text-transform:uppercase;color:#56b483}
.eyebrow.tone-info{color:light-dark(#3b63c9,#6591fc)}
.eyebrow.tone-warn{color:var(--orange)}
.hd h1{margin-top:22.5px;font-size:40px;line-height:46px;font-weight:600;letter-spacing:-.04em;color:light-dark(#060a13,#f8ffff);overflow-wrap:anywhere}
.hd p{margin-top:6px;font-size:21px;line-height:30px;letter-spacing:-.01em;color:light-dark(#646d83,#8c95ac)}
.hd .xbtn{margin-top:32px}
.xbtn{display:inline-flex;align-items:center;gap:16.8px;flex:none;height:56px;padding:0 18.2px 0 19.4px;border:1px solid light-dark(#e6e8ee,#393a3e);border-radius:7px;background:light-dark(#fefefe,#161b22);color:light-dark(#05070d,#faffff);font-size:17px;font-weight:450;letter-spacing:-.025em;text-decoration:none}
.xbtn .ic{width:22px;height:22px}
.xbtn span{position:relative;top:1px}
.xbtn .gh{stroke:none;fill:currentColor;width:31.5px;height:31.5px;color:light-dark(#070a11,#faffff)}
.ic.fl{fill:currentColor;stroke:none}
.xbtn .ext{width:24px;height:24px;color:light-dark(#535b74,#8c95b0);margin-left:-3.2px}
.xbtn:hover,.act:hover{background:light-dark(#fafafb,#161b22)}
.repos{margin:28.5px 0 0;padding:22px 19px 21px 26px;border:1px solid light-dark(#eff0f4,#333438);border-radius:9.5px;background:light-dark(#f9fafb,#161b22)}
.rh{display:flex;align-items:center;gap:31px;height:60px}
.rh .gh{width:52px;height:52px;stroke:none;fill:currentColor;color:light-dark(#060a11,#f8ffff);position:relative;top:1px}
.rh .tx{flex:1;min-width:0;position:relative;top:4px}
.rh .tx strong{font-size:22px;line-height:26px;font-weight:550;letter-spacing:-.04em;color:light-dark(#04060c,#faffff);margin:0}
.rh .tx .ds{margin-top:5.65px;font-size:17.5px;line-height:22px;font-weight:400;letter-spacing:-.01em;color:light-dark(#4d5770,#8a95b0)}
.rh .xbtn{height:50px;padding:0 24px 0 23px;font-size:17px;font-weight:550;letter-spacing:-.035em;border-radius:6.4px;border-color:light-dark(#eaecf1,#35373b)}
.chips{display:flex;flex-wrap:wrap;gap:18.5px;margin:25px 0 0 -3.5px;list-style:none}
.chips li{display:flex;align-items:center;gap:13.2px;height:49px;padding:0 39.8px 0 15.5px;border:1px solid light-dark(#eff1f5,#313338);border-radius:7.2px;background:light-dark(#f6f7f9,#161b22);color:light-dark(#3d485a,#8996aa);font-size:16px;letter-spacing:-.01em}
.chips .ic{width:24px;height:24px;color:light-dark(#5a647a,#8b95ad);position:relative;top:-.5px}
.chips .more{padding:0 33px 0 20px}
.steps{margin:21px 0 0;border:1px solid light-dark(#eef0f4,#323438);border-radius:5.5px;list-style:none;overflow:hidden}
.row+.row{border-top:1px solid light-dark(#eef0f4,#323438)}
.row:last-child .rw{min-height:90px}
.row:nth-child(2) .rw{padding-top:1.4px}
.row:nth-child(3) .rw{padding-top:1.8px}
.row:nth-child(4) .rw{padding-top:4px}
.rw{display:grid;grid-template-columns:36px 38px 1fr auto;column-gap:0;align-items:center;min-height:91px;padding:0 18px 0 23px;list-style:none}
details>summary{cursor:pointer}
details>summary::-webkit-details-marker{display:none}
details[open]>summary{min-height:91px}
.n{position:relative;top:-3px;display:grid;place-items:center;width:36px;height:36px;padding-bottom:1.5px;border:1px solid light-dark(#e3e5e9,#3b3d41);border-radius:50%;background:light-dark(#f1f2f4,#212325);color:light-dark(#05070d,#faffff);font-size:21px;font-weight:600}
.n::after{content:"";position:absolute;left:54px;top:-1px;width:1px;height:36px;background:light-dark(#eceef2,#262729)}
.st{position:relative;top:-3px;display:grid;place-items:center;width:38px;height:38px;margin-left:38px;border-radius:50%}
.st .ring{width:38px;height:38px;border:2.8px solid #6c7488;border-radius:50%;box-sizing:border-box}
.st .tick{display:none;width:38px;height:38px;place-items:center;border-radius:50%;background:#1eac7a;color:#fff}
.st .tick .ic{width:24px;height:24px;stroke-width:3.7;position:relative;top:-1.2px}
.row.done .ring{display:none}
.row.done .tick{display:grid}
.row .sr.y{display:none}
.row.done .sr.y{display:inline}
.row.done .sr.x{display:none}
.tx strong{display:block;margin-top:-3.2px;font-size:21.75px;line-height:26px;font-weight:500;letter-spacing:-.04em;color:light-dark(#03050d,#f9ffff)}
.tx .ds{display:block;margin-top:3.6px;font-size:17px;line-height:24px;font-weight:500;letter-spacing:-.02em;color:light-dark(#626b81,#8b95ad)}
.rw .tx{margin-left:85px;min-width:0}
.act{display:inline-flex;align-items:center;justify-content:center;gap:10.6px;width:213px;height:52px;padding:2px 0 0 4px;border:1px solid light-dark(#eceff3,#323539);border-radius:6px;background:light-dark(#fefefe,#161b22);color:light-dark(#05070d,#faffff);font-size:17px;font-weight:500;letter-spacing:-.035em;text-decoration:none;position:relative;top:-1.5px}
.act .ic{width:23.5px;height:23.5px;stroke-width:1.5;color:light-dark(#5f687d,#8c95ac)}
.act .ext{width:21.35px;height:21.35px;color:light-dark(#535b74,#8c95b0)}
.act .ic.sl{width:30px;height:30px;stroke-width:0;color:inherit}
.pn{padding:0 19px 24px 182px}
.pn p{margin:0 0 10px;font-size:15px;line-height:22px;color:light-dark(#646b78,#9199a7)}
.pn pre{margin:0;padding:13px 16px;border-radius:10px;background:#10141d;color:#e8eaf0;font:13.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}
.cmd{position:relative;margin:0 0 10px}
.cmd pre{padding-right:84px}
.cp{position:absolute;top:8px;right:8px;height:30px;padding:0 12px;border:1px solid #3a4151;border-radius:6px;background:#1b2130;color:#e8eaf0;font-family:inherit;font-size:13px;font-weight:500;line-height:1;cursor:pointer}
.cp:hover{background:#262d3f}
.cp[hidden]{display:none}
.help{display:flex;align-items:center;gap:20.5px;margin:27px 0 0;padding:16px 3px 23px 1px;border-top:1px solid light-dark(#e9ecef,#34383c)}
.help .book{display:grid;place-items:center;flex:none;width:59px;height:59px;border-radius:12px;background:light-dark(#f3f4f6,#1f2123);color:light-dark(#606a82,#8b95af);position:relative;top:-.4px}
.help .book .ic{width:32px;height:32px;color:light-dark(#5c667d,#8b95ae);position:relative;top:-.6px}
.help .tx{flex:1}
.help strong{display:block;font-size:17px;line-height:22px;font-weight:500;letter-spacing:-.06em;color:light-dark(#05070d,#faffff);position:relative;top:1.6px}
.help .ds{display:block;margin-top:4.5px;font-size:15.5px;line-height:22px;font-weight:450;letter-spacing:.005em;color:light-dark(#576076,#8b95ad)}
.help .lk{display:inline-flex;align-items:center;gap:12.3px;margin-left:20px;color:light-dark(#58627c,#8a95b1);font-size:16.25px;font-weight:450;letter-spacing:-.03em;text-decoration:none;position:relative;top:-.2px}
.help .lk:hover{color:var(--ink)}
.help .lk .ic{width:23.4px;height:23.4px;color:light-dark(#646e86,#8b95af);position:relative;top:-1.2px}
.help .lk+.lk{font-size:16.5px;font-weight:400;letter-spacing:-.015em;gap:11.3px;color:light-dark(#5b657d,#8b95af)}
.help .lk+.lk .ic{width:26px;height:26px;color:light-dark(#626b83,#8b95ae);top:-1.3px;left:1px;position:relative}
.pickl{margin:26px 0 0;list-style:none;border:1px solid light-dark(#ececef,#36363b);border-radius:12px;overflow:hidden}
.pickl li+li{border-top:1px solid light-dark(#ececef,#36363b)}
.pickl a{display:flex;align-items:center;gap:16px;min-height:72px;padding:0 20px;color:var(--ink);font-size:18px;font-weight:500;text-decoration:none;overflow-wrap:anywhere}
.pickl a:hover{background:light-dark(#fafafb,#161b22)}
.pickl .ic{width:24px;height:24px;stroke-width:1.5;color:light-dark(#646b78,#9199a7)}
.pickl .go{margin-left:auto}
.p-flow .foot{position:relative;z-index:2;margin:24px 0 0;padding-bottom:32px}
@media (max-width:900px){
.p-flow{--nh:68px;--ls:.1}
.acct{width:44px;height:44px}
.card{left:0;margin-top:16px;padding:22px 16px 0}
.card.narrow{padding-bottom:22px}
.hd{flex-wrap:wrap;gap:16px}
.seal{width:56px;height:56px}
.seal .ic{width:28px;height:28px}
.hd .ttl{flex-basis:calc(100% - 72px)}
.hd h1{font-size:25px;line-height:31px}
.hd p{font-size:16px;line-height:24px}
.hd .xbtn{width:100%;justify-content:center}
.repos,.steps,.help{margin-left:0}
.n::after{display:none}
.repos{padding:16px}
.rh{flex-wrap:wrap;height:auto;gap:12px}
.rh .xbtn{width:100%;justify-content:center}
.rw,.row:nth-child(n) .rw{grid-template-columns:34px 30px 1fr;row-gap:12px;padding:16px;min-height:0}
.n{width:34px;height:34px}
.st,.st .ring,.st .tick{width:30px;height:30px}
.st{margin-left:10px}
.rw .tx{margin-left:14px}
.tx strong{font-size:17px}
.tx .ds{font-size:15px;line-height:22px}
.rw .act{grid-column:1/-1;width:100%}
.pn{padding:0 16px 18px}
.help{flex-wrap:wrap}
.help .tx{flex-basis:calc(100% - 80px)}
.help .lk{margin:0 24px 0 0}
.cp{top:2px;right:2px;height:44px;min-width:56px}
.help{row-gap:8px}
.help .lk{min-height:44px}
details:not([open]) .cp{display:none}
.pickl{display:grid;gap:8px;border:0;border-radius:0;overflow:visible}
.pickl li,.pickl li+li{border:1px solid light-dark(#ececef,#36363b);border-radius:12px;overflow:hidden}
}
`;

const SCRIPT = `(function(){if(navigator.clipboard)document.querySelectorAll("[data-copy]").forEach(function(b){var l=b.textContent;b.hidden=false;b.addEventListener("click",function(){navigator.clipboard.writeText(b.previousElementSibling.textContent).then(function(){b.textContent=b.getAttribute("data-copied");setTimeout(function(){b.textContent=l},1800)}).catch(function(){})})});
var m=document.querySelector("[data-status]");if(!m)return;var u=m.getAttribute("data-status");var a=document.querySelector('[data-step="agent"]');var s=document.querySelector('[data-step="slack"]');if(!a||!s)return;
var t=setInterval(function(){fetch(u,{credentials:"same-origin"}).then(function(r){return r.ok?r.json():null}).then(function(d){if(!d)return;if(d.agents_online>0)a.classList.add("done");if(d.slack_linked)s.classList.add("done");if(d.agents_online>0&&d.slack_linked)clearInterval(t)}).catch(function(){})},3000)})();`;

const ACCOUNT = `<a class="acct" href="/" aria-label="${e(T.account)}">${icon("account")}</a>`;

/** GitHub's settings page for the installation: where repositories are granted and removed. */
function manageUrl(v: InstalledView) {
	const base = v.accountType === "Organization" ? `https://github.com/organizations/${encodeURIComponent(v.accountLogin)}` : "https://github.com";
	return `${base}/settings/installations/${v.installationId}`;
}

type Tone = "ok" | "info" | "warn";

/** The card header: a round glyph, the eyebrow badge, the title and subtitle, and an optional control at the right. */
function head(glyph: string, tone: Tone, badge: string, title: string, subtitle: string, aside = "") {
	return (
		`<div class="hd"><span class="seal tone-${tone}">${icon(glyph)}</span><div class="ttl"><span class="eyebrow tone-${tone}">${e(badge)}</span>` +
		`<h1>${e(title)}</h1><p>${e(subtitle)}</p></div>${aside}</div>`
	);
}

interface Row {
	key: string;
	n: number;
	done: boolean;
	title: string;
	body: string;
	/** The control at the right: a link, or for a row with a panel, a label shown inside the summary. */
	action: string;
	panel?: string;
	open?: boolean;
}

function row(r: Row) {
	const state =
		`<span class="st"><span class="ring"></span><span class="tick">${icon("tick")}</span></span>`;
	const text = `<span class="tx"><strong>${e(r.title)}</strong><span class="ds">${e(r.body)}</span></span>`;
	const status = `<span class="sr x"> ${e(T.todo)}</span><span class="sr y"> ${e(T.done)}</span>`;
	const cells = `<span class="n">${r.n}</span>${state}${text}`;
	const cls = `row${r.done ? " done" : ""}`;
	if (r.panel === undefined) return `<li class="${cls}" data-step="${r.key}"><div class="rw">${cells}${r.action}${status}</div></li>`;
	return (
		`<li class="${cls}" data-step="${r.key}"><details${r.open ? " open" : ""}><summary class="rw">${cells}<span class="act">${r.action}</span>${status}</summary>` +
		`<div class="pn">${r.panel}</div></details></li>`
	);
}

function repoChips(p: InstallProgress) {
	if (p.repoCount === 0) return "";
	const chips = p.repoNames.map((n) => `<li>${icon("repo-tile", "fl")}<span>${e(n)}</span></li>`).join("");
	const more = p.repoCount - p.repoNames.length;
	const tail = more > 0 ? `<li class="more">${e(T.reposMore(more))}</li>` : "";
	return `<ul class="chips">${chips}${tail}</ul>`;
}

function steps(v: InstalledView) {
	const p = v.progress;
	const ext = icon("ext-box", "ext fl");
	const cmd = (text: string) =>
		`<div class="cmd"><pre>${e(text)}</pre><button type="button" class="cp" data-copy data-copied="${e(T.copied)}" hidden>${e(T.copy)}</button></div>`;
	const connect = cmd(`sudo hookci connect --hub ${v.hubOrigin} ${v.pairToken}`);
	const commands = v.latestAgentVersion
		? `<p>${e(T.pairRun)}</p>${cmd(`curl -fsSL ${v.hubOrigin}/install | sh -s -- ${v.pairToken}`)}${connect}`
		: `<p>${e(S.pages.installedNoRelease)} <a href="${e(S.pages.buildAgentUrl)}">${e(S.pages.buildAgent)}</a> ${e(S.pages.installedPairBuilt)}</p>${connect}`;
	const pair = `${commands}<p>${e(S.pages.installedExpiry(v.expiresInMinutes))}</p>`;
	const bind = `<p>${e(T.bindRun)}</p>${cmd(T.bindCommand)}`;
	const rows = [
		row({ key: "agent", n: 1, done: p.agentOnline, title: T.pairTitle, body: T.pairBody, action: `${e(T.pairAction)}${ext}`, panel: pair, open: !p.agentOnline }),
		row({
			key: "config",
			n: 2,
			done: p.configured,
			title: T.configTitle,
			body: T.configBody,
			action: `<a class="act" href="${e(S.site.docsUrl)}" rel="noopener noreferrer">${e(T.configAction)}${ext}</a>`,
		}),
		row({ key: "bind", n: 3, done: p.bound, title: T.bindTitle, body: T.bindBody, action: e(T.bindAction), panel: bind }),
		row({
			key: "slack",
			n: 4,
			done: p.slackLinked,
			title: T.slackTitle,
			body: T.slackBody,
			action: `<a class="act" href="/slack/install?installation_id=${v.installationId}">${icon("slack", "sl")}${e(T.slackAction)}</a>`,
		}),
	];
	return `<ol class="steps" aria-label="${e(T.stepsLabel)}">${rows.join("")}</ol>`;
}

function helpBar() {
	return (
		`<div class="help"><span class="book">${icon("book-open", "fl")}</span><div class="tx"><strong>${e(T.helpTitle)}</strong><span class="ds">${e(T.helpBody)}</span></div>` +
		`<a class="lk" href="${e(S.site.docsUrl)}" rel="noopener noreferrer">${icon("ext-box", "fl")}${e(T.helpDocs)}</a>` +
		`<a class="lk" href="/support">${icon("chat-bubble", "fl")}${e(T.helpSupport)}</a></div>`
	);
}

/**
 * The success page: the setup checklist with the pair token, repositories granted, the Add to Slack
 * link, and (with script) live ticks as the agent comes online and Slack is linked.
 */
export function installedPage(v: InstalledView) {
	const manage = `<a class="xbtn" href="${e(manageUrl(v))}" rel="noopener noreferrer">${icon("github", "gh")}<span>${e(T.manage)}</span>${icon("ext-box", "ext fl")}</a>`;
	const repos =
		`<section class="repos"><div class="rh">${icon("github", "gh")}<div class="tx"><strong>${e(T.repos)}</strong>` +
		`<span class="ds">${e(T.reposGranted(v.progress.repoSelection, v.progress.repoCount))}</span></div>` +
		`<a class="xbtn" href="${e(manageUrl(v))}" rel="noopener noreferrer"><span>${e(T.reposView)}</span></a></div>${repoChips(v.progress)}</section>`;
	const body =
		`${siteNav(ACCOUNT)}<main class="card" data-status="/start/status?installation_id=${v.installationId}">` +
		`${head("tick", "ok", T.badge, T.title(v.accountLogin), T.subtitle, manage)}${repos}${steps(v)}${helpBar()}</main>${legalFooter()}`;
	return shellResponse(
		{ title: T.title(v.accountLogin), bodyClass: "p-flow", css: CSS, body, icons: FLOW_ICONS, script: SCRIPT, connect: true },
		{ cookies: v.cookies },
	);
}

function narrow(glyph: string, tone: Tone, badge: string, title: string, subtitle: string, inner: string, cookies: string[]) {
	const body = `${siteNav(ACCOUNT)}<main class="card narrow">${head(glyph, tone, badge, title, subtitle)}${inner}</main>${legalFooter()}`;
	return shellResponse({ title, bodyClass: "p-flow", css: CSS, body, icons: FLOW_ICONS }, { cookies });
}

/** Shown to a user who can see the installation but does not administer its account: no pair token, no Add to Slack link. */
export function installedNotAdminPage(accountLogin: string, cookies: string[]) {
	return narrow("info", "info", T.notAdminBadge, T.notAdminTitle, S.pages.installedNotAdmin(accountLogin), "", cookies);
}

/** Shown for setup_action=update: GitHub changed permissions or repositories; no new pair token. */
export function updatedPage(accountLogin: string, cookies: string[]) {
	const U = S.flow.updated;
	return narrow("check", "ok", U.badge, U.title, U.body(accountLogin), "", cookies);
}

/** Lists the installations the user can access; each link finishes the install through /start with the session cookie. */
export function pickerPage(installations: { id: number; accountLogin: string }[], cookies: string[]) {
	const P = S.flow.pick;
	const items = installations
		.map((i) => `<li><a href="/start?installation_id=${i.id}">${icon("building")}<span>${e(i.accountLogin)}</span>${icon("arrow", "go")}</a></li>`)
		.join("");
	return narrow("users", "warn", P.badge, P.title, P.body, `<ul class="pickl">${items}</ul>`, cookies);
}
