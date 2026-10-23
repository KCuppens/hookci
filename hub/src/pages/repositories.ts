// The dashboard's Repositories tab and the form behind its "Bind repositories"
// button: per repository the checks agent, deploy bindings, Slack channels and
// last run of one installation, with a search and a filter. Every dynamic value
// goes through escapeHtml.

import { type RepositoryFilter, type RepositoryItem, REPOSITORY_FILTERS, repositoriesPath } from "../dashboard/repositories";
import { deployEnv } from "../db/bindings";
import type { InstallationRow } from "../db/installations";
import { type AgentListRow, REPOSITORY_LIMIT } from "../db/tabs";
import { S } from "../strings";
import { accountNav, agoHtml, agoPlain, appPage, type DashboardChrome, initOf, pageHead, rowMenu, viewerOf } from "./dashboard";
import { escapeHtml } from "./layout";
import { PILL_CSS, PILL_ICONS, runPill } from "./pills";
import { REPO_ICONS } from "./repositories-icons";
import { REPO_OFFSETS } from "./repositories-offsets";
import { icon } from "./shell";

const D = S.dashboard;
const T = D.reposPage;
const C = T.cols;
const e = escapeHtml;

const ICONS: Record<string, string> = {
	...PILL_ICONS,
	...REPO_ICONS,
	"slack-c":
		'<path fill="#E01E5A" stroke="none" d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"/>' +
		'<path fill="#36C5F0" stroke="none" d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"/>' +
		'<path fill="#2EB67D" stroke="none" d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"/>' +
		'<path fill="#ECB22E" stroke="none" d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>',
};

const RT = ".repositories .scroll table";
const RH = `${RT} thead tr`;
const RB = `${RT} tbody tr`;

const CSS = `
${PILL_CSS}
.repositories{background:#f9fafb}
.rc{display:flex;align-items:center;align-self:flex-start;gap:16px;margin-top:5px}
.rcount{margin:5.2px 8px 0 0;color:#525e80;font-size:14.5px;letter-spacing:-.025em}
.rcount b{color:#111b38;font-weight:700}
.rc .ob{height:42px;gap:13px;padding:0 14.5px 0 16.4px;border-color:#e6ebf2;border-radius:5.3px;background:#fefefe;font-size:13.5px;font-weight:500;letter-spacing:-.03em}
.rc .ob .ic{width:19.3px;height:19.3px}
.repositories .ob.bl{border-color:#055cfa;background:#0163fc;color:#fff;letter-spacing:.004em;cursor:pointer}
.repositories .ob.bl:hover{background:#0458e0}
.repositories .card{border-color:#e9edf4}
.tb{display:flex;gap:15px;padding:13px 13px 13px 13px;border-bottom:1px solid #e9edf4}
.sf{flex:1}
.sf label{position:relative;display:block}
.sf .ic{position:absolute;top:9.6px;left:13.4px;width:17.8px;height:17.8px;color:#667399}
.sf input{width:100%;height:37px;padding:0 16px 0 43.9px;border:1px solid #e5eaf2;border-radius:5.5px;background:#fff;color:var(--ink);font:inherit;font-size:13.25px;letter-spacing:-.03em}
.sf input::placeholder{color:#657298;opacity:1}
.repositories .fm summary{display:inline-flex;width:auto;height:37px;gap:0;padding:0 14px 0 14.8px;border:1px solid #e5eaf2;border-radius:5.5px;background:#fff;color:#050c25;font-size:13.75px;font-weight:500;letter-spacing:-.03em}
.fm summary .ic:first-child{width:17.2px;height:17.2px;margin-right:12px}
.fm summary .ic:last-child{width:9.6px;height:9.6px;margin-left:14.6px}
.fm .menu a[aria-current]{font-weight:600}
.repositories .scroll{overflow:visible}
.repositories table{table-layout:fixed;min-width:var(--app-w)}
.repositories th{height:39.5px;padding:4px 16px 0;background:#f9fbfd;color:#6f799a;font-size:12px;font-weight:400;letter-spacing:-.005em;white-space:nowrap}
.repositories th:nth-child(1){width:55px}
.repositories th:nth-child(2){width:207px}
.repositories th:nth-child(3){width:147px}
.repositories th:nth-child(4){width:240px}
.repositories th:nth-child(5){width:196px}
.repositories th:nth-child(6){width:190px}
.repositories th:nth-child(7){width:210px}
.repositories th:nth-child(3){padding-left:15.3px;letter-spacing:-.015em}
.repositories th:nth-child(4){padding-left:14.4px;letter-spacing:-.02em}
.repositories th:nth-child(5){padding-left:18px}
.repositories th:nth-child(6){padding-left:15.3px;letter-spacing:-.02em}
.repositories th:nth-child(7){padding-left:15.1px;letter-spacing:-.01em}
.repositories th:nth-child(8){padding-left:15.5px}
.repositories td{padding:0 16px;border-top-color:#eef1f6;vertical-align:middle}
.repositories tbody tr:nth-child(1) td{height:59.5px}
.repositories tbody tr:nth-child(2) td{height:57.5px}
.repositories tbody tr:nth-child(3) td{height:63px}
.repositories tbody tr:nth-child(4) td{height:59px}
.repositories tbody tr:nth-child(5) td{height:59.5px}
.repositories tbody tr:nth-child(6) td{height:61.7px}
.repositories tbody tr:nth-child(7) td{height:62.5px}
.repositories tbody tr:nth-child(8) td{height:61.3px}
.repositories th .up{display:inline-block;width:11.2px;height:11.2px;margin-left:8px;vertical-align:-1px}
.repositories td.ck,.repositories th.ck{padding-left:17px;padding-right:0}
.ck input,.ck2 input{appearance:none;display:block;width:17.3px;height:17.3px;margin:0;border:1.5px solid #8f98b4;border-radius:4.5px;background:#fff}
.ck2 input{display:inline-block}
.ck input:checked,.ck2 input:checked{border-color:#0565fe;background:#0565fe}
.rpo{display:flex;align-items:center;gap:16px}
.rpo .ic{flex:none;width:27px;height:27px;fill:var(--ink);stroke:none}
.rpo b{display:block;color:#05081c;font-size:15px;font-weight:500;letter-spacing:-.04em;line-height:20px}
.sb{display:block;color:#586489;font-size:13px;letter-spacing:-.03em;line-height:21px}
.rpo>span{min-width:0}
.rpo .sb{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.repositories .chip{height:24px;padding:0 9.5px;border-radius:4.6px;font-size:12px;font-weight:500;letter-spacing:-.035em;line-height:24px}
.repositories td>.chip{padding:0 10.2px;background:#edeff3;color:#4c5873;font-weight:400;letter-spacing:-.03em;line-height:23.8px;height:24px}
.repositories .chip.stg{background:#feefdb;color:#aa4008}
.repositories .chip.prev{background:#e3effe;color:#0b58fa;font-size:12.25px;letter-spacing:-.055em}
.repositories .chip.prod{background:#fee7e7;color:#f90a10;letter-spacing:-.025em}
.ag{display:flex;align-items:center;gap:11.4px;color:#050718;font-size:15px;font-weight:500;letter-spacing:-.045em}
.ag .dot{position:relative;top:1.2px;flex:none;width:10.8px;height:10.8px;margin-right:0;background:#13b970}
.ag .dot.down{background:#dc2626}
.ag .dot.nb{background:#6b7090}
.ag+.sb{margin-left:22.2px;color:#697397}
.dp{display:flex;flex-wrap:wrap;gap:12px;margin-left:2px}
.dp .chip{height:22.5px;line-height:22.5px}
.ag .chip{height:23px;padding:0 12px;line-height:23px}
.ag .chip.prod{padding:0 15px}
.repositories tbody tr:nth-child(1) .dp .chip.prod{padding:0 8.5px}
.repositories tbody tr:nth-child(4) .dp .chip.prod{padding:0 11.5px}
.repositories tbody tr:nth-child(7) .dp .chip{padding:0 10.5px}
.repositories tbody tr:nth-child(n+6):nth-child(-n+7) td:nth-child(3)>.chip{height:25px;padding-top:1px}
.repositories tbody tr:nth-child(7) td:nth-child(3)>.chip{height:26px;padding-top:2px}
.repositories tbody tr:nth-child(2) td:nth-child(7)>.sb{letter-spacing:.028em}
.repositories tbody tr:nth-child(3) td:nth-child(7)>.sb{letter-spacing:.015em}
.repositories tbody tr:nth-child(4) td:nth-child(7)>.sb{letter-spacing:.016em}
.repositories tbody tr:nth-child(5) td:nth-child(7)>.sb{letter-spacing:.011em}
.repositories tbody tr:nth-child(6) td:nth-child(7)>.sb{letter-spacing:.002em}
.repositories tbody tr:nth-child(7) td:nth-child(7)>.sb{letter-spacing:-.005em}
.repositories tbody tr:nth-child(8) td:nth-child(7)>.sb{letter-spacing:.012em}
.repositories tbody tr:nth-child(2) .sl{letter-spacing:-.065em}
.repositories tbody tr:nth-child(5) .sl .er{letter-spacing:-.063em}
.repositories tbody tr:nth-child(3) .rpo .sb{letter-spacing:-.012em}
.repositories tbody tr:nth-child(8) .rpo .sb{letter-spacing:-.014em}
.sl{display:flex;align-items:center;gap:12.6px;margin-left:1.4px;color:#515a7b;font-size:13.75px;letter-spacing:-.04em;line-height:21px}
.sl>.ic{position:relative;top:-1.1px}
.repositories tbody tr:nth-child(1) .sl{gap:9.2px}
.sl>div{display:grid}
.sl .er{color:#e95052}
.sl .ic{flex:none;width:18px;height:18px}
.sl .wn{width:18px;height:18px;align-self:flex-start}
.nd{display:inline-block;width:13px;height:1.4px;background:currentColor;vertical-align:middle}
.ag .nd{width:14px;margin-right:26.6px;color:#091429}
.repositories td .rp{display:flex;width:max-content;min-width:0;height:24.4px;gap:12.6px;margin:6px 0 -2.5px;padding:0 10.3px 0 7.4px;border-radius:12px;font-size:11.75px;font-weight:500;letter-spacing:-.04em;line-height:24.4px}
.repositories .rp .ic{width:18.4px;height:18.4px}
.repositories .rp.ok{background:#e0f7ec;color:#0e7b46}
.repositories .rp.rn{background:#e5f0fe;color:#0140fe;padding-right:12.3px}
.repositories .rp.fl{background:#fee7e7;color:#f7080f;padding-right:12.3px}
.repositories .rp.sp{background:#efe9fe;color:#3712ee}
.repositories .rp.cn{background:#eceef2;color:#515978;padding-right:8.3px}
.repositories td .rp.nn{height:28px;gap:10.1px;margin-top:5px;padding:0;background:none;color:#8993b0}
.repositories .rp.nn .ic{width:28px;height:28px}
.rp+.sb{margin-left:36.4px;color:#6f7ca2;font-size:11.75px;letter-spacing:-.015em}
.mu,.none{color:#6b7490}
.repositories td:nth-child(5).mu{color:#8893b4}
.repositories td:nth-child(6).mu{color:#7a82a2}
.none{padding:28px 16px;text-align:center}
.ac{display:flex;align-items:center;gap:27.3px;margin-left:-2px}
.ac .ob{justify-content:flex-start;width:89.5px;height:38.7px;gap:13.6px;padding:0 0 0 14.6px;border-color:#e4e8f2;border-radius:5.5px;font-size:12.75px;font-weight:500;letter-spacing:-.04em}
.ac .ob .ic{width:13.5px;height:13.5px}
.ac .mnu summary{width:14.3px;height:14.3px;color:#4a5984}
.ac .mnu summary .ic{width:14.3px;height:14.3px}
${REPO_OFFSETS}
.eb{display:flex;flex-direction:column;align-items:center;gap:0;margin-top:0;padding:10px 24px 26px;text-align:center}
.gh{display:grid;place-items:center;width:64px;height:64px;margin-bottom:10px;border-radius:50%;background:#f3f4f7;color:#4a5373}
.gh .ic{width:34px;height:34px;fill:currentColor;stroke:none}
.eb h2{margin:0 0 3px;font-size:21.3px;font-weight:600;line-height:26px}
.eb p{margin:0 0 12px;color:#677592;font-size:13.3px;line-height:20px}
.eb .ob{height:38px;gap:8px;padding:0 20px;font-size:12.6px}
.lk{display:inline-flex;align-items:center;gap:6px;margin-top:11px;color:#0565fe;font-size:12.6px;font-weight:500;line-height:20px;text-decoration:none}
.lk .ic{width:15px;height:15px}
.note{margin:0 0 16px;padding:12px 16px;border:1px solid #cfe8da;border-radius:9px;background:#eef9f3;color:#14704a;font-size:14px}
.bp{padding:24px}
.bf{display:grid;gap:18px;max-width:520px}
.bf label,.bf legend{display:grid;gap:6px;font-size:14px;font-weight:600}
.bf fieldset{display:grid;gap:8px;max-height:260px;margin:0;padding:12px 14px;overflow:auto;border:1px solid var(--line);border-radius:9px}
.bf select,.bf input[type=text]{height:38px;padding:0 12px;border:1px solid var(--line);border-radius:9px;background:#fff;font:inherit;font-weight:400}
.ck2{display:flex!important;grid-template-columns:none;align-items:center;gap:10px!important;font-weight:400!important}
@media screen{
.repositories .bg{display:none}
}
@media (max-width:1500px){
${RT}{display:block;width:100%;min-width:0}
${RT} thead,${RT} tbody{display:block}
${RH},${RB}{display:grid;align-items:center}
${RH} th,${RB} td{display:block;width:auto;min-width:0;height:auto;padding:0;border:0;overflow-wrap:anywhere}
${RB} td>*,${RB} td .rpo>span{left:0;top:0}
${RB} td .rp{max-width:100%;margin:0;font-size:12px}
${RB} td .rp+.sb{margin:2px 0 0;font-size:12px}
${RB} td .chip{height:auto!important;min-height:24px;max-width:100%;padding-top:3px!important;padding-bottom:3px!important;line-height:1.35!important;white-space:normal;overflow-wrap:anywhere}
${RB} td .ag{flex-wrap:wrap;row-gap:6px}
${RB} td .ac{margin-left:0;gap:14px}
${RB} td.none{grid-column:1/-1;padding:24px 16px}
}
@media (min-width:1101px) and (max-width:1500px){
${RH},${RB}{grid-template-columns:44px minmax(140px,1.3fr) minmax(70px,.6fr) minmax(140px,1.1fr) minmax(100px,.9fr) minmax(120px,1fr) minmax(120px,1fr) 150px;column-gap:14px;padding:12px 16px}
${RH}{min-height:40px;padding-top:0;padding-bottom:0;background:#f9fbfd}
${RB}{border-top:1px solid #eef1f6}
${RB}:first-child{border-top:0}
${RB} td.ck,${RH} th.ck{justify-self:start;padding-left:1px}
}
@media (max-width:1100px){
.repositories .card{margin:0}
${RH}{display:flex;align-items:center;min-height:52px;padding:4px 16px;background:#f9fbfd;border-bottom:1px solid #eef1f6}
${RH}:has(input[data-all][hidden]){display:none}
${RH} th{display:none}
${RH} th.ck{display:flex;align-items:center;gap:10px;min-height:44px;padding-left:1px;color:#586489;font-size:14px}
${RH} th.ck::after{content:attr(data-label)}
${RB}{position:relative;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:12px 16px;padding:12px 16px 16px;border-top:1px solid #eef1f6}
${RB}:first-child{border-top:0}
${RB} td.ck{position:absolute;left:4px;top:12px;display:grid;place-items:center;width:44px;height:44px}
${RB} td:nth-child(2){grid-column:1/-1;grid-row:1;display:flex;align-items:center;min-height:44px;padding-left:32px}
${RB} td:nth-child(3){grid-column:1;grid-row:2}
${RB} td:nth-child(7){grid-column:2;grid-row:2}
${RB} td:nth-child(4){grid-column:1/-1;grid-row:3}
${RB} td:nth-child(5){grid-column:1/-1;grid-row:4}
${RB} td:nth-child(6){grid-column:1/-1;grid-row:5}
${RB} td:nth-child(8){grid-column:1/-1;grid-row:6}
${RB} td[data-label]::before{content:attr(data-label);display:block;margin-bottom:4px;color:#6f799a;font-size:12px;line-height:16px}
${RB} td .rpo{flex:1;gap:12px;min-width:0}
${RB} td .rpo b{overflow-wrap:anywhere}
${RB} td .rpo .sb{overflow:visible;white-space:normal;text-overflow:clip}
${RB} td .ac .ob{flex:1;width:auto;height:44px;justify-content:center;padding:0 14px;font-size:14px}
${RB} td .ac .mnu{margin-left:auto}
${RB} td .ac .mnu summary{width:44px;height:44px;border:1px solid #e4e8f2;border-radius:5.5px}
${RB} td .ac .mnu summary .ic{width:18px;height:18px}
${RB} td .ac .menu{top:48px}
${RB} td .rp::after{content:"";position:absolute;left:0;right:0;top:-10px;bottom:-10px}
${RH} th.ck input,.ck2 input{position:relative}
.ck input::after,.ck2 input::after{content:"";position:absolute;left:-14.85px;top:-14.85px;width:44px;height:44px}
.menu a,.menu button{display:flex;align-items:center;min-height:44px}
.rc{flex-wrap:wrap;justify-content:flex-end}
.rc .ob,.repositories .ph>.ob,.eb .ob{height:44px}
.sf input{height:44px;font-size:16px}
.sf .ic{top:13px}
.repositories .fm summary{height:44px;font-size:16px}
.lk{min-height:44px}
.bf select,.bf input[type=text]{height:44px;font-size:16px}
.ck2{min-height:44px;gap:12px!important;overflow-wrap:anywhere}
.bf{grid-template-columns:minmax(0,1fr)}
.bf fieldset{max-height:none;min-width:0}
.ck2 input{flex:none}
}
@media (min-width:600px) and (max-width:1100px){
${RB}{grid-template-columns:repeat(3,minmax(0,1fr))}
${RB} td:nth-child(3){grid-column:1;grid-row:2}
${RB} td:nth-child(4){grid-column:2;grid-row:2}
${RB} td:nth-child(5){grid-column:3;grid-row:2}
${RB} td:nth-child(6){grid-column:1;grid-row:3}
${RB} td:nth-child(7){grid-column:2;grid-row:3}
${RB} td:nth-child(8){grid-column:3;grid-row:3}
}
@media (max-width:767px){
.repositories .ph{flex-direction:column;align-items:stretch;gap:16px}
.rc{align-self:stretch;margin-top:0;gap:12px}
.rcount{flex:1 1 100%;margin:0}
.rc .ob,.repositories .ph>.ob{flex:1 1 100%;justify-content:center}
.tb{flex-direction:column;align-items:stretch;gap:12px;padding:12px}
.sf{flex:none;width:100%}
.repositories .fm{display:block}
.repositories .fm summary{display:flex;width:100%}
.fm summary .ic:last-child{margin-left:auto}
.fm .menu{left:0;right:0}
.bp{padding:16px}
.bf{max-width:none;gap:16px}
.bf .ob.bl{width:100%;justify-content:center;height:44px}
.eb{padding:8px 16px 24px}
.eb .ob{width:100%;justify-content:center}
}
@media (pointer:coarse){
.ac .ob,.rc .ob{height:44px}
.ac .mnu summary{width:44px;height:44px}
.repositories .fm summary,.sf input{height:44px}
.menu a,.menu button{display:flex;align-items:center;min-height:44px}
}
`;

/** The page script: the header checkbox of the table selects every row; without script it stays hidden. */
const SCRIPT = `
for (const all of document.querySelectorAll("[data-all]")) {
  all.hidden = false;
  all.addEventListener("change", () => {
    for (const box of document.querySelectorAll("input[name=repo]")) box.checked = all.checked;
  });
}
`;

export interface RepositoriesView {
	account: InstallationRow;
	accounts: readonly InstallationRow[];
	login: string;
	now: number;
	chrome?: DashboardChrome;
	cookies?: string[];
	/** The repositories that match the search and filter. */
	items: readonly RepositoryItem[];
	/** Whether the installation has any repository at all (the empty state is for none, no match is not empty). */
	any: boolean;
	search: string;
	filter: RepositoryFilter;
	/** The list was cut at the repository limit. */
	cut: boolean;
}

function shortName(fullName: string): string {
	return fullName.slice(fullName.indexOf("/") + 1);
}

/** The mark for "nothing here": a short rule, with the word for screen readers. */
function dash(): string {
	return `<i class="nd"><span class="sr">${e(D.none)}</span></i>`;
}

function repoCell(r: RepositoryItem): string {
	if (r.full_name === null) return `<td><div class="rpo">${icon("github")}<span><b>${e(D.unknownRepo)}</b><span class="sb">${r.repo_id}</span></span></div></td>`;
	return `<td><div class="rpo">${icon("github")}<span><b>${e(shortName(r.full_name))}</b><span class="sb">${e(shortName(r.full_name))}</span></span></div></td>`;
}

function checksCell(r: RepositoryItem, now: number): string {
	const a = r.checks;
	if (a === null) return `<td data-label="${e(C.agent)}"><div class="ag"><i class="dot nb"></i>${dash()}<span class="chip stg">${e(T.noAgent)}</span></div><span class="sb">${e(T.checksOff)}</span></td>`;
	if (a.agent_status === "online") return `<td data-label="${e(C.agent)}"><div class="ag"><i class="dot on"></i>${e(a.agent_name)}</div><span class="sb">${e(T.pullRequestChecks)}</span></td>`;
	const chip = a.agent_status === "revoked" ? T.agentRevoked : T.agentOffline;
	const seen = a.agent_last_seen_at === null ? D.agentNeverSeen : D.agentLastSeen(agoPlain(a.agent_last_seen_at, now));
	return `<td data-label="${e(C.agent)}"><div class="ag"><i class="dot down"></i>${e(a.agent_name)}<span class="chip prod">${e(chip)}</span></div><span class="sb">${e(seen)}</span></td>`;
}

function deployCell(r: RepositoryItem): string {
	if (r.deploys.length === 0) return `<td class="mu" data-label="${e(C.deploy)}">${dash()}</td>`;
	const chips = r.deploys.map((b) => {
		const env = deployEnv(b.target) ?? b.target;
		const cls = env === "production" || env === "prod" ? " prod" : env === "staging" ? " prev" : "";
		return `<span class="chip${cls}">${e(env)}</span>`;
	});
	return `<td data-label="${e(C.deploy)}"><div class="dp">${chips.join("")}</div></td>`;
}

function slackCell(r: RepositoryItem): string {
	if (r.watches.length === 0) return `<td class="mu" data-label="${e(C.slack)}">${dash()}</td>`;
	const broken = r.watches.some((w) => w.status === "broken");
	const lines = r.watches.map((w) => {
		const name = w.channel_name === null ? (w.channel_id.startsWith("D") ? T.directMessage : w.channel_id) : `#${w.channel_name}`;
		return `<span>${e(name)}</span>${w.status === "broken" ? `<span class="er">${e(T.channelNotFound)}</span>` : ""}`;
	});
	return `<td data-label="${e(C.slack)}"><div class="sl">${icon(broken ? "warn" : "slack-c", broken ? "wn" : "")}<div>${lines.join("")}</div></div></td>`;
}

function lastRunCell(r: RepositoryItem, base: string, now: number): string {
	if (r.last_state === null || r.last_run_id === null) return `<td data-label="${e(C.lastRun)}"><span class="rp nn">${icon("p-none")}${dash()}</span><span class="sb">${e(T.noRuns)}</span></td>`;
	const href = `${base}/runs/${encodeURIComponent(r.last_run_id)}`;
	return `<td data-label="${e(C.lastRun)}">${runPill(r.last_state, e(href))}<span class="sb">${agoHtml(r.last_started_at, now, D.ago.minutesLong)}</span></td>`;
}

function actionsCell(r: RepositoryItem, base: string): string {
	const runs = `${base}/runs?repo=${r.repo_id}`;
	if (r.full_name === null) return `<td><div class="ac">${rowMenu([[runs, T.viewRuns]], null)}</div></td>`;
	const github = `https://github.com/${r.full_name}`;
	const menu = rowMenu(
		[
			[runs, T.viewRuns],
			[`${base}/repositories/bind?repo=${r.repo_id}`, T.bindRow],
		],
		null,
	);
	return `<td><div class="ac"><a class="ob" href="${e(github)}" rel="noopener noreferrer">${e(T.open)}${icon("out")}</a>${menu}</div></td>`;
}

function row(r: RepositoryItem, base: string, now: number): string {
	const check =
		r.full_name === null ? "" : `<input type="checkbox" name="repo" value="${r.repo_id}" form="repo-pick" aria-label="${e(T.selectRow(r.full_name))}">`;
	return `<tr><td class="ck">${check}</td>${repoCell(r)}<td data-label="${e(C.branch)}"><span class="chip">${e(r.default_branch ?? D.none)}</span></td>${checksCell(r, now)}${deployCell(r)}${slackCell(r)}${lastRunCell(r, base, now)}${actionsCell(r, base)}</tr>`;
}

function toolbar(v: RepositoriesView): string {
	const path = repositoriesPath(v.account.id, "", "all");
	const keep = v.filter === "all" ? "" : `<input type="hidden" name="filter" value="${e(v.filter)}">`;
	const search =
		`<form class="sf" method="get" action="${e(path)}" role="search"><label><span class="sr">${e(T.searchLabel)}</span>${icon("search")}` +
		`<input type="search" name="q" value="${e(v.search)}" placeholder="${e(T.searchPlaceholder)}" maxlength="100" autocomplete="off" spellcheck="false"></label>${keep}</form>`;
	const links = REPOSITORY_FILTERS.map((f) => {
		const on = f === v.filter;
		return `<a href="${e(repositoriesPath(v.account.id, v.search, f))}"${on ? ' aria-current="true"' : ""}>${e(T.filters[f])}</a>`;
	});
	const label = v.filter === "all" ? T.filter : T.filters[v.filter];
	const menu = `<details class="mnu fm"><summary class="ob">${icon("funnel")}${e(label)}${icon("chevd")}</summary><div class="menu">${links.join("")}</div></details>`;
	return `<div class="tb">${search}${menu}</div>`;
}

function emptyCard(v: RepositoriesView): string {
	const url = D.settingsPage.githubInstallationUrl(v.account.account_type, v.account.account_login, v.account.id);
	return (
		`<section class="card eb"><span class="gh">${icon("github")}</span><h2>${e(T.empty.title)}</h2><p>${e(T.empty.body)}</p>` +
		`<a class="ob" href="${e(url)}" rel="noopener noreferrer">${icon("out")}${e(T.empty.adjust)}</a>` +
		`<a class="lk" href="${e(S.site.docsUrl)}" rel="noopener noreferrer">${e(T.empty.learn)}${icon("arrow")}</a></section>`
	);
}

function tableCard(v: RepositoriesView): string {
	const base = `/app/${v.account.id}`;
	const c = T.cols;
	const head =
		`<th class="ck" data-label="${e(T.selectAll)}"><input type="checkbox" data-all hidden aria-label="${e(T.selectAll)}"></th><th>${e(c.repo)}${icon("sort", "up")}</th><th>${e(c.branch)}</th><th>${e(c.agent)}</th>` +
		`<th>${e(c.deploy)}</th><th>${e(c.slack)}</th><th>${e(c.lastRun)}</th><th>${e(c.actions)}</th>`;
	const body = v.items.length === 0 ? `<tr><td class="none" colspan="8">${e(T.noMatches)}</td></tr>` : v.items.map((r) => row(r, base, v.now)).join("");
	const note = v.cut ? `<div class="pg"><span>${e(T.cut(REPOSITORY_LIMIT))}</span></div>` : "";
	return `<section class="card vis">${toolbar(v)}<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${note}</section>`;
}

export function repositoriesPage(v: RepositoriesView): Promise<Response> {
	const base = `/app/${v.account.id}`;
	const url = D.settingsPage.githubInstallationUrl(v.account.account_type, v.account.account_login, v.account.id);
	const bind = v.any ? `<button type="submit" class="ob bl" form="repo-pick">${icon("link")}${e(T.bind)}</button>` : "";
	const controls =
		`<div class="rc"><span class="rcount"><b>${v.items.length}</b> ${e(T.unit(v.items.length))}</span>` +
		`<a class="ob" href="${e(url)}" rel="noopener noreferrer">${icon("link")}${e(T.openOnGithub)}</a>${bind}</div>`;
	const picker = `<form id="repo-pick" method="get" action="${e(`${base}/repositories/bind`)}"></form>`;
	return appPage({
		title: v.account.account_login,
		bodyClass: "repositories",
		main: `${accountNav(v.accounts, v.account.id)}${pageHead(T.title, T.subtitle, controls)}${picker}${v.any ? tableCard(v) : emptyCard(v)}`,
		viewer: viewerOf(v, "repositories"),
		init: initOf(v),
		css: CSS,
		icons: ICONS,
		script: SCRIPT,
		avatars: false,
	});
}

export interface BindView {
	account: InstallationRow;
	accounts: readonly InstallationRow[];
	login: string;
	chrome?: DashboardChrome;
	cookies?: string[];
	csrf: string;
	repos: readonly { repo_id: number; full_name: string }[];
	agents: readonly Pick<AgentListRow, "agent_id" | "name">[];
	/** The repositories ticked when the form opens. */
	selected: ReadonlySet<number>;
	notice: string | null;
}

export function bindPage(v: BindView): Promise<Response> {
	const B = T.bindPage;
	const base = `/app/${v.account.id}`;
	const ready = v.repos.length > 0 && v.agents.length > 0;
	const repos = v.repos.map(
		(r) => `<label class="ck2"><input type="checkbox" name="r${r.repo_id}" value="1"${v.selected.has(r.repo_id) ? " checked" : ""}>${e(r.full_name)}</label>`,
	);
	const agents = v.agents.map((a) => `<option value="${e(a.agent_id)}">${e(a.name)}</option>`);
	const form =
		`<form class="bf" method="post" action="${e(`${base}/repositories/bind`)}"><input type="hidden" name="csrf" value="${e(v.csrf)}">` +
		`<fieldset><legend>${e(B.repo)}</legend>${repos.join("")}</fieldset>` +
		`<label>${e(B.kind)}<select name="kind"><option value="checks">${e(B.checks)}</option><option value="deploy">${e(B.deploy)}</option></select></label>` +
		`<label>${e(B.env)}<input type="text" name="env" maxlength="40" autocomplete="off" spellcheck="false"><span class="sb">${e(B.envHint)}</span></label>` +
		`<label>${e(B.agent)}<select name="agent_id">${agents.join("")}</select></label>` +
		`<button type="submit" class="ob bl">${e(B.submit)}</button></form>`;
	const empty = v.repos.length === 0 ? B.noRepos : B.noAgents;
	const notice = v.notice === null ? "" : `<p class="note" role="status">${e(v.notice)}</p>`;
	const body = ready ? form : `<p class="empty">${e(empty)}</p>`;
	return appPage({
		title: v.account.account_login,
		bodyClass: "repositories",
		main:
			`${accountNav(v.accounts, v.account.id)}${pageHead(B.title, B.subtitle, `<a class="ob" href="${e(`${base}/repositories`)}">${e(B.back)}</a>`)}` +
			`${notice}<section class="card bp">${body}</section>`,
		viewer: viewerOf(v, "repositories"),
		init: initOf(v),
		css: CSS,
	});
}
