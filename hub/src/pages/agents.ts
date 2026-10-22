// The Agents tab: the table of the installation's agents, or the empty state with the install command.

import type { InstallationRow } from "../db/installations";
import type { AgentListRow } from "../db/tabs";
import { upgradeHint } from "../slack/home";
import { S } from "../strings";
import { AGENT_ICONS, AGENT_UI_CSS, copyBox, platformLines, statusChip } from "./agent-ui";
import { AGENTS_ICONS } from "./agents-icons";
import { accountNav, agoHtml, appPage, type DashboardChrome, dateOf, initOf, PAGE_SCRIPT, rowMenu, viewerOf } from "./dashboard";
import { escapeHtml } from "./layout";
import { nil, TABLE_UI_CSS } from "./runs";
import { icon } from "./shell";

const A = S.agents;
const e = escapeHtml;

export interface AgentsView {
	account: InstallationRow;
	accounts: readonly InstallationRow[];
	login: string;
	chrome?: DashboardChrome;
	cookies?: string[];
	/** The csrf token of the pair form. */
	csrf: string;
	now: number;
	hubOrigin: string;
	latestAgentVersion: string;
	agents: readonly AgentListRow[];
	/** Active agents allowed per installation. */
	limit: number;
	/** The text for the request's ?notice= value. */
	notice: string | null;
}

const SEARCH_SCRIPT = `
for (const input of document.querySelectorAll("[data-filter]")) {
  const rows = document.querySelectorAll("[data-q]");
  const none = document.getElementById(input.dataset.filter);
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    for (const r of rows) {
      const hit = r.dataset.q.includes(q);
      r.hidden = !hit;
      if (hit) shown++;
    }
    none.hidden = shown > 0;
  });
}
`;

const CSS = `
body.agents{--ink:#060913;--muted:#4f5b79;--line:#e6e9ef;--line-2:#f0f2f5;background:#f9fafb;font-size:15px;will-change:opacity}
body.agents .app{--ls:.117;--bmw:41;--bww:112;--bgap:9.9;--bwy:6.9;--lx:.28px;--ly:-1px;border-bottom:1px solid #e9ecf2}
body.agents .app .in{width:1414px;max-width:calc(100% - 48px);height:73px;padding:0;gap:0}
body.agents .tabs{gap:28px;margin-left:158.6px}
body.agents .tabs a{padding:6.4px 6px 0;border-bottom-width:3px;margin-bottom:0;font-size:14.4px;color:#596383}
body.agents .tabs a:nth-child(2){margin-left:-2.36px}
body.agents .tabs a:nth-child(3){margin-left:3.02px}
body.agents .tabs a:nth-child(4){margin-left:4.57px}
body.agents .tabs a:nth-child(5){margin-left:5px}
body.agents .tabs a.on{border-color:#f64d27;color:var(--ink)}
body.agents .rt{gap:49.65px;margin-right:1px;font-size:14.4px}
body.agents .rt a{color:#5b6685}
body.agents .rt .dc{position:relative;top:1.35px}
body.agents .usr{width:50px;height:50px;color:#676d89}
body.agents .usr .ic{position:relative;top:-.5px;left:-.5px;width:28px;height:28px}
body.agents .main{width:1414px;max-width:calc(100% - 48px);padding:22px 0 72px}
body.agents .ph{align-items:flex-start;height:97px;margin:0}
body.agents h1{font-size:39px;letter-spacing:-.01em;line-height:48px;color:#070e1b}
body.agents .sub{margin-top:1px;font-size:18.5px;letter-spacing:.01em;line-height:26px;color:#5a6481}
body.agents .card{border-radius:12px;background:#fefdfe;border-color:#e6e9ef}
${TABLE_UI_CSS}
${AGENT_UI_CSS}
.ac{display:flex;align-items:center;gap:24.1px;align-self:flex-start;margin:18px 1px 0 0}
.ct{display:flex;align-items:center;gap:9.5px;font-size:15.75px;letter-spacing:.055em;color:#5a6481}
.ct b{font-weight:700;color:#070a18}
.ct .ic{position:relative;top:-.8px;width:24px;height:24px;margin:0 -3px;color:#535b79}
.ac form{display:block}
.pb{display:flex;align-items:center;justify-content:flex-start;gap:8.4px;width:199px;height:43px;padding:0 0 .2px 15px;border:1px solid #0460fa;border-radius:5.6px;background:#0b68fc;color:#f5fbfe;font:inherit;font-size:14px;font-weight:500;letter-spacing:.039em;cursor:pointer}
.pb .ic{width:24px;height:24px}
.nt{margin-bottom:16px;padding:12px 16px;border:1px solid #dae7f9;border-radius:12px;background:#f3f8fe;font-size:14px;color:#1c3a78}
.srch{padding:17px}
.srch .sel input{height:42px;padding-left:46.2px;border-color:#e8ecf2;border-radius:5.2px;background:#fefefe;font-size:15.5px;font-weight:500;letter-spacing:-.035em}
.srch .sel input::placeholder{color:#6c7692}
.srch .sel .l{left:13px;width:24px;height:24px;margin-top:-12px;color:#555d78}
.agt{table-layout:fixed;width:1412px;border-collapse:separate;border-spacing:0}
.agt th,.agt td{padding:0;text-align:left;vertical-align:middle;white-space:nowrap}
.agt th:first-child,.agt td:first-child{padding-left:22px}
.agt th{height:44px;padding-top:2px;border-top:1px solid #eceef3;border-bottom:1px solid #eef0f4;background:#f9fafc;font-size:15px;font-weight:400;color:#5b6582;text-transform:none;letter-spacing:0}
.agt th.s{padding-left:8px}
.agt th:nth-child(1){letter-spacing:-.015em}
.agt th:nth-child(2){letter-spacing:-.025em}
.agt th:nth-child(3){font-size:14.75px;letter-spacing:-.01em}
.agt th:nth-child(4){font-size:14.25px;letter-spacing:-.01em}
.agt th:nth-child(5){font-size:15.5px}
.agt th:nth-child(6){font-size:16.5px;letter-spacing:-.02em}
.agt th:nth-child(7){letter-spacing:-.05em}
.agt th:nth-child(8){font-size:14.5px}
.agt th:nth-child(9){letter-spacing:-.03em}
.agt th:nth-child(10){font-size:15.5px;letter-spacing:-.05em}
.agt td{height:67px;border-top:1px solid #eef0f5;font-size:15px;font-weight:400;color:#5d6986}
.agt tbody tr:first-child td{border-top:0}
.agt tbody tr:nth-child(2) td{height:65px;padding-bottom:3px}
.agt tbody tr:nth-child(3) td{height:70px}
.agt tbody tr:nth-child(3) td:nth-child(3){padding-bottom:1px}
.agt tbody tr:nth-child(3) td:last-child{padding-bottom:2px}
.agt tbody tr:nth-child(3) .ug{padding-top:0}
.agt tbody tr:nth-child(4) td{height:68px}
.agt tbody tr:nth-child(5) td{height:71px;padding-bottom:4px}
.agt .ug{padding-top:2px}
.agt td:not(.mn){overflow:hidden;text-overflow:ellipsis}
.agt col:nth-child(1){width:148.5px}
.agt col:nth-child(2){width:151px}
.agt col:nth-child(3){width:150px}
.agt col:nth-child(4){width:95px}
.agt col:nth-child(5){width:198px}
.agt col:nth-child(6){width:152px}
.agt col:nth-child(7){width:113px}
.agt col:nth-child(8){width:90px}
.agt col:nth-child(9){width:153px}
.agt col:nth-child(10){width:161.5px}
.agt .nm b{font-size:15.5px;font-weight:500;letter-spacing:-.02em;color:#070a16}
.agt .hn{font-size:15px;font-weight:500;letter-spacing:-.045em;color:#080e1e}
.agt .vs{font-size:15.5px;letter-spacing:.02em;color:#445272}
.agt .pr,.agt .rp{font-size:15.25px;color:#586480}
.agt .pr{letter-spacing:-.08em}
.agt .as{gap:8.2px;font-size:13.5px;letter-spacing:-.01em}
.agt .as i{width:12px;height:12px;background:#707790}
.agt .as b{height:26px;padding:0 10.5px;border-radius:10.5px;background:#eef0f4;color:#1f2942;line-height:26px}
.agt .as.online i{background:#0db06f}
.agt .as.offline b{height:24px;line-height:24px}
.agt .as.online b{height:25px;background:#e1f8ec;color:#087841;line-height:25px}
.agt .as.revoked i{background:#e5333b}
.agt .as.revoked b{background:#fde5e6;color:#d60d11;font-size:14.25px;font-weight:600;letter-spacing:-.07em}
.agt .up{display:block;width:max-content;height:24px;padding:0 8px 0 8.2px;border-radius:7px;background:#feedce;color:#9f3f0b;font-size:14px;font-weight:500;letter-spacing:-.06em;line-height:24px}
.agt .us{display:block;margin-top:1px;font-size:14px;letter-spacing:-.01em;color:#626a88}
.agt .pf{font-size:15px;letter-spacing:-.03em;color:#606984}
.agt .pf span{display:block;line-height:22.4px}
.agt .pf span+span{letter-spacing:-.01em;color:#58617d}
.agt .ls{font-size:15px;letter-spacing:-.035em}
.agt .ls span{display:block;line-height:22px}
.agt .go{display:inline-flex;align-items:center;gap:9px;width:100px;height:40px;padding:0 0 0 15.3px;border:1px solid #e6e9f0;border-radius:5.7px;background:#fefdfe;color:#11192f;font-size:15px;font-weight:500;letter-spacing:-.015em;text-decoration:none}
.agt .go .ic{width:24px;height:24px;color:#5d6685}
.agt .go.dis{color:#8a92aa;background:#f7f8fa;border-color:#e7eaf0;border-radius:6.1px}
.agt .go.dis .ic{color:#a1a8bb}
.agt td.ac2{overflow:visible;padding-left:.5px}
.agt .ac2{display:flex;align-items:center;gap:18px}
.agt .mnu summary .ic{width:24px;height:24px;color:#596486}
.agt tr.rv td{background:#f5f6f9;background-clip:padding-box;border-top-color:#f3f4f8;color:#6f7892}
.agt tr.rv td:first-child{padding-left:21px;border-left:1px solid #fefdfe;border-radius:5.5px 0 0 5.5px}
.agt tr.rv td:last-child{border-right:1px solid #fefdfe;border-radius:0 5.5px 5.5px 0}
.agt tr.rv .nm b{color:#707995}
.agt tr.rv .hn{color:#646e8a}
.agt tr.rv .ls span:first-child{letter-spacing:-.045em;color:#717b95}
.agt tr.rv .ls span+span{font-size:14.75px;letter-spacing:-.02em;color:#777f9a}
.agt tr.rv .mnu summary .ic{color:#929bb6}
.agt td.none{padding:30px 0;text-align:center;color:var(--muted)}
.em{display:flex;flex-direction:column;align-items:center;padding:33px 24px 31.3px;text-align:center}
.em .ico{display:grid;place-items:center;width:78px;height:78px;border-radius:50%;background:#f0f1f4;color:#50566f}
.em .ico .ic{width:40px;height:40px}
.em h2{margin-top:14.5px;font-size:25.5px;line-height:30px;font-weight:700;letter-spacing:-.03em;color:#060e1e}
.em p{margin-top:7.6px;font-size:15.75px;letter-spacing:0;color:#596482}
.em .cb{width:631px;max-width:100%;height:57px;margin-top:18px;padding:0 15px 0 22px;border-color:#e9ecf2;border-radius:7px;background:#fafbfd;font-size:14px;color:#4b5673}
.em .cb .cp{width:24px;height:24px;color:#5c6584}
.em .cb .cp .ic{width:24px;height:24px}
.em .lk{position:relative;left:2.2px;display:inline-flex;align-items:center;gap:0;margin-top:17.7px;font-size:15.5px;font-weight:400;letter-spacing:-.025em;color:#0a56db;text-decoration:none}
.em .lk .ic{width:24px;height:24px;margin-left:3.3px;color:#1852d9}
@media (max-width:900px){
body.agents .app .in{flex-wrap:wrap;align-items:center;gap:0 12px;height:auto;min-height:56px;padding:10px 16px 0}
body.agents .tabs{order:3;flex:1 0 100%;gap:0;margin-left:-8px;height:44px;overflow-x:auto;scrollbar-width:none}
body.agents .tabs a{flex:none;padding:0 8px;font-size:14px;margin-left:0}
body.agents .tabs a:nth-child(n){margin-left:0}
body.agents .rt{gap:14px;margin-right:0}
body.agents .usr{width:34px;height:34px}
body.agents .usr .ic{top:0;left:0;width:18px;height:18px}
body.agents .main{padding-top:20px}
body.agents .ph{flex-wrap:wrap;gap:16px;height:auto;margin-bottom:20px}
body.agents h1{font-size:32px;line-height:38px}
body.agents .sub{font-size:16px}
.ac{margin-top:0;flex-wrap:wrap}
.agt,.agt tbody,.agt tr,.agt td{display:block;width:auto}
.agt thead,.agt col{display:none}
.agt tr{position:relative;padding:12px 16px;border-top:1px solid #edeff3}
.agt tbody tr:first-child{border-top:0}
.agt td,.agt td:not(.mn),.agt th:first-child,.agt td:first-child{display:flex;align-items:center;justify-content:space-between;gap:12px;height:auto;min-height:32px;padding:4px 0;border:0;overflow:visible;white-space:normal}
.agt td::before{content:attr(data-l);flex:none;font-size:12.5px;font-weight:500;color:#5f6987}
.agt td.nm{padding-right:40px;font-size:16px}
.agt td.nm::before{content:none}
.agt td.ac2{justify-content:flex-start}
.agt td.ac2::before{content:none}
.agt tr.rv td:first-child{border-left:0;padding-left:0}
.agt tr.rv td:last-child{border-right:0}
.agt tr.rv{background:#f4f6f9}
.agt .up{white-space:nowrap;margin-left:auto}
.agt .us{text-align:right;margin-left:auto}
.agt td.ug{flex-wrap:wrap;justify-content:flex-end}
.agt td.ug::before{margin-right:auto}
.agt td.ug .us{flex:1 1 100%;margin-left:0}
.agt tbody tr:nth-child(n) td{height:auto;min-height:32px;padding-top:4px;padding-bottom:4px}
.agt td.pf{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:12px;align-items:center}
.agt td.pf::before{grid-row:1/span 2}
.agt td.pf span{grid-column:2}
.agt td.ls{flex-wrap:wrap;justify-content:flex-end}
.agt td.ls::before{margin-right:auto}
.agt .pf,.agt .ls{text-align:right}
.em .cb{height:auto;min-height:48px;padding-top:10px;padding-bottom:10px}
.em .cb code{white-space:normal;overflow-wrap:anywhere;text-align:left}
.ac{width:100%;gap:12px 24px}
.ac form{flex:1 1 100%}
.pb{width:100%;height:48px;justify-content:center;padding:0 16px}
.srch .sel input{height:48px;font-size:16px}
.scroll{overflow:visible}
.agt td.nm{overflow-wrap:anywhere;word-break:break-word}
.agt .hn,.agt .pf,.agt .ls,.agt .us{overflow-wrap:anywhere}
.agt td.ac2{gap:12px;justify-content:stretch}
.agt .go{flex:1 1 auto;justify-content:center;width:auto;min-height:44px;padding:0 16px}
.em .cb .cp{width:44px;height:44px;flex:none}
.em .lk{min-height:44px;left:0}
}
@media (min-width:901px) and (max-width:1100px){
.agt{width:100%}
.agt col:nth-child(2),.agt th:nth-child(2),.agt td:nth-child(2),.agt col:nth-child(7),.agt th:nth-child(7),.agt td:nth-child(7),.agt col:nth-child(8),.agt th:nth-child(8),.agt td:nth-child(8){display:none}
.agt col:nth-child(1){width:130px}
.agt col:nth-child(3){width:112px}
.agt col:nth-child(4){width:70px}
.agt col:nth-child(5){width:140px}
.agt col:nth-child(6){width:110px}
.agt col:nth-child(9){width:110px}
.agt col:nth-child(10){width:150px}
.agt .ac2{gap:8px}
}
@media (pointer:coarse){
.agt .go{min-height:44px}
}
`;

function upgradeCell(a: AgentListRow, v: AgentsView): string {
	if (a.revoked_at !== null || upgradeHint(a.protocol_version, a.agent_version, v.latestAgentVersion) === undefined) return nil();
	return `<span class="up">${e(A.upgradeAvailable)}</span><span class="us">${e(A.upgradeCommand)}</span>`;
}

function seenCell(a: AgentListRow, v: AgentsView): string {
	if (a.revoked_at !== null) return `<span>${e(A.revokedOn)}</span><span>${e(dateOf(a.revoked_at))}</span>`;
	if (a.last_seen_at === null) return e(A.neverSeen);
	return agoHtml(a.last_seen_at, v.now, S.dashboard.ago.minutesLong);
}

function agentRow(a: AgentListRow, v: AgentsView, base: string): string {
	const href = `${base}/agents/${encodeURIComponent(a.agent_id)}`;
	const revoked = a.revoked_at !== null;
	const query = [a.name, a.hostname, a.os_release ?? a.os, a.arch, a.agent_version].filter((p): p is string => p !== null).join(" ").toLowerCase();
	const open = revoked
		? `<span class="go dis" aria-disabled="true">${e(A.open)}${icon("out")}</span>`
		: `<a class="go" href="${e(href)}">${e(A.open)}${icon("out")}</a>`;
	const menu = rowMenu([[href, A.viewAgent]], href);
	const cells: [string, string, string][] = [
		["nm", "", `<b>${e(a.name)}</b>`],
		["hn", A.cols.hostname, a.hostname === null ? nil() : e(a.hostname)],
		["", A.cols.status, statusChip(a.status)],
		["vs", A.cols.version, a.agent_version === null ? nil() : e(a.agent_version)],
		["ug", A.cols.upgrade, upgradeCell(a, v)],
		["pf", A.cols.platform, platformLines(a) || nil()],
		["pr", A.cols.protocol, a.protocol_version === null ? nil() : e(A.protocol(a.protocol_version))],
		["rp", A.cols.repos, String(a.repos)],
		["ls", A.cols.lastSeen, seenCell(a, v)],
	];
	const tds = cells.map(([cls, label, html]) => `<td${cls === "" ? "" : ` class="${cls}"`}${label === "" ? "" : ` data-l="${e(label)}"`}>${html}</td>`).join("");
	return `<tr${revoked ? ' class="rv"' : ""} data-q="${e(query)}">${tds}<td class="ac2">${open}${menu}</td></tr>`;
}

function agentTable(v: AgentsView, base: string): string {
	const c = A.cols;
	const heads = [c.name, c.hostname, c.status, c.version, c.upgrade, c.platform, c.protocol, c.repos, c.lastSeen, c.actions];
	const head = heads.map((label, i) => `<th${i === 2 ? ' class="s"' : ""}>${e(label)}</th>`).join("");
	const rows = v.agents.map((a) => agentRow(a, v, base)).join("");
	const none = `<tr id="agents-none" hidden><td class="none" colspan="10">${e(A.noMatches)}</td></tr>`;
	const search = `<label class="sel"><span class="sr">${e(A.searchLabel)}</span>${icon("search", "l")}<input type="search" data-filter="agents-none" placeholder="${e(A.searchPlaceholder)}" autocomplete="off"></label>`;
	return (
		`<section class="card"><div class="srch">${search}</div><div class="scroll"><table class="agt"><colgroup>${"<col>".repeat(10)}</colgroup>` +
		`<thead><tr>${head}</tr></thead><tbody>${rows}${none}</tbody></table></div></section>`
	);
}

function emptyCard(v: AgentsView): string {
	return (
		`<section class="card em"><span class="ico">${icon("server")}</span><h2>${e(A.empty.title)}</h2><p>${e(A.empty.body)}</p>` +
		`${copyBox(A.installCommand(v.hubOrigin))}<a class="lk" href="${e(S.site.docsUrl)}" rel="noopener noreferrer">${e(A.empty.guide)}${icon("go-arrow")}</a></section>`
	);
}

function pairForm(v: AgentsView, base: string): string {
	return `<form method="post" action="${base}/agents/pair"><input type="hidden" name="csrf" value="${e(v.csrf)}"><button class="pb" type="submit">${icon("plus")}${e(A.pair)}</button></form>`;
}

function countText(v: AgentsView): string {
	const active = v.agents.filter((a) => a.revoked_at === null).length;
	const text = e(A.count(active, v.limit)).replace(/^\d+/, "<b>$&</b>");
	return `<span class="ct"><span>${text}</span><span title="${e(A.countTip)}" tabindex="0">${icon("info")}<span class="sr">${e(A.countTip)}</span></span></span>`;
}

export function agentsPage(v: AgentsView): Promise<Response> {
	const base = `/app/${v.account.id}`;
	const head = `<div class="ph"><div><h1>${e(A.title)}</h1><p class="sub">${e(A.subtitle)}</p></div><div class="ac">${countText(v)}${pairForm(v, base)}</div></div>`;
	const notice = v.notice === null ? "" : `<p class="nt" role="status">${e(v.notice)}</p>`;
	const main = `${accountNav(v.accounts, v.account.id)}${head}${notice}${v.agents.length === 0 ? emptyCard(v) : agentTable(v, base)}`;
	return appPage({
		title: v.account.account_login,
		bodyClass: "agents",
		main,
		viewer: viewerOf(v, "agents"),
		init: initOf(v),
		css: CSS,
		icons: { ...AGENT_ICONS, ...AGENTS_ICONS },
		script: PAGE_SCRIPT + SEARCH_SCRIPT,
		forms: true,
	});
}
