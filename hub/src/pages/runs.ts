// The runs tab: filters, live updates, the run table with its state pills and numbered pagination.
// Built on the dashboard chrome (dashboard.ts); every dynamic value goes through escapeHtml.

import type { InstallationRow } from "../db/installations";
import type { AgentOption, RepoOption } from "../db/overview";
import type { RunListRow } from "../db/runs";
import { S } from "../strings";
import { accountNav, agoHtml, appPage, branchLabel, type DashboardChrome, durationText, initOf, PAGE_SCRIPT, rowMenu, runHref, shortRepo, viewerOf } from "./dashboard";
import { escapeHtml } from "./layout";
import { PILL_CSS, PILL_ICONS, runPill } from "./pills";
import { RUNS_TRACED_ICONS } from "./runs-icons";
import { icon } from "./shell";

const D = S.dashboard;
const L = D.list;
const e = escapeHtml;

export interface RunsFilters {
	state: string;
	repo: string;
	branch: string;
	sha: string;
	author: string;
	agent: string;
	event: string;
	sort: "newest" | "oldest";
}

export interface RunsView {
	account: InstallationRow;
	accounts: readonly InstallationRow[];
	login: string;
	chrome?: DashboardChrome;
	cookies?: string[];
	now: number;
	runs: readonly RunListRow[];
	total: number;
	page: number;
	perPage: number;
	/** The newest run's rowid: the live banner counts runs recorded after it. */
	newest: number;
	filters: RunsFilters;
	options: {
		states: readonly string[];
		repos: readonly RepoOption[];
		branches: readonly string[];
		authors: readonly string[];
		agents: readonly AgentOption[];
		events: readonly string[];
	};
}

const FILTER_KEYS = ["state", "repo", "branch", "sha", "author", "agent", "event"] as const;

export const ENV_CLASS: Record<string, string> = { production: "prod", prod: "prod", staging: "stg", preview: "prev" };

/** States whose duration is still counting: the table shows the time since the run started. */
const LIVE_STATES: Record<string, true> = { running: true, verifying: true, rolling_back: true };

export const RUN_ICONS: Record<string, string> = {
	monitor: '<path d="M5.5 3.5h13a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19V5a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M4 14.5c2.2-1.2 4.2.8 8 .8s5.8-2 8-.8M8.5 20.5h7"/>',
	circle: '<circle cx="12" cy="12" r="9.6"/>',
	stack: '<rect x="4" y="3.5" width="16" height="7.5" rx="2.2"/><rect x="4" y="13" width="16" height="7.5" rx="2.2"/><path d="M7.5 7.3h.1M7.5 16.8h.1M11 7.3h6M11 16.8h6"/>',
	x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
	info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2M12 7.9v.1" stroke-width="2.1"/>',
};

const PAGE_ICONS: Record<string, string> = {
	...RUN_ICONS,
	...PILL_ICONS,
	...RUNS_TRACED_ICONS,
	ellipsis: '<path d="M6.1 12h.01M12 12h.01M17.9 12h.01" stroke-width="3.4"/>',
};

/** Table chrome shared with the agents pages: select/search boxes, dash, author avatar, environment chips. */
export const TABLE_UI_CSS = `
.sel{position:relative;display:block}
.sel select,.sel input{appearance:none;width:100%;height:42px;padding:0 36px 0 45px;border:1px solid #e1e5ec;border-radius:9px;background:#fff;color:#1c2232;font:inherit;font-size:14px;font-weight:450;text-overflow:ellipsis;cursor:pointer}
.sel input{padding-right:12px;cursor:text;font-weight:400}
.sel input::placeholder{color:#6f7a96;opacity:1}
.sel input::-webkit-search-cancel-button{display:none}
.sel .ic{position:absolute;top:50%;pointer-events:none}
.sel .l{left:14px;width:23px;height:23px;margin-top:-11.5px;color:#47506a}
.sel .r{right:11px;width:21px;height:21px;margin-top:-10.5px;color:#5d6785}
.nil{display:inline-block;width:14px;height:1.5px;vertical-align:middle;background:#8b94a8}
.au{display:inline-flex;align-items:center;gap:9px;height:26px;margin:-3px 0;vertical-align:top;max-width:100%}
.av{position:relative;flex:none;width:26px;height:26px;overflow:hidden;border-radius:50%;background:#e3e8f1}
.av .ini{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#56607d}
.av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.rtb .chip{display:inline-block;height:24px;margin:-2px 0;padding:0 10px;border-radius:6px;vertical-align:top;font-size:13px;line-height:24px;font-weight:500}
.rtb .chip.stg{background:#dae8fe;color:#0518b2}
.rtb .chip.prev{background:#ebe2fe;color:#270eb4}
.rtb .chip.prod{background:#fee5e6;color:#a60003}
`;

const CSS = `
body.runs{--ink:#060913;--muted:#4f5b79;--line:#ebeef3;--line-2:#f0f2f5;background:#f9f9fa;font-size:15px;will-change:opacity}
.runs .card{border-radius:7px;background:#fdfdfd;border-color:#edeff3}
.rc{display:flex;gap:16px;align-self:flex-start;margin-top:22px}
.live{display:flex;align-items:center;gap:12px;width:133px;height:42px;padding:0 0 0 16px;border:1px solid #e7eaf0;border-radius:10px;background:#fff;font-size:13px;font-weight:500;letter-spacing:-.01em;color:#090e1f}
.live i{position:relative;left:-1px;top:-1px;width:11px;height:11px;border-radius:50%;background:#1ab477}
.rc .sel{width:144px}
.rc .ob{height:42px}
.fb{display:grid;grid-template-columns:198px 173px 161px 162px 161px 165px minmax(0,1fr);column-gap:13px;padding:12px}
.fb .fs{margin-left:4px}
${TABLE_UI_CSS}
${PILL_CSS}
.rtb td a.rp,.rtb td a.rp:hover{text-decoration:none}
.rc .sel select{padding:1px 34px 0 13.7px;color:#070a16;font-size:14px;font-weight:400;letter-spacing:.0165em}
.fb .sel select{color:#0a0e1a;font-size:15.5px;font-weight:400;letter-spacing:-.045em}
.fb .sel input{font-size:14.5px;letter-spacing:-.015em}
.fb .sel input::placeholder{color:#66708c}
.fb .sel .l{left:13px;top:10px;width:24px;height:24px;margin-top:0}
.fb .sel:nth-child(4) .l,.fb .sel:nth-child(6) .l{left:14px}
.fb .sel .r{right:10.3px;top:9px;width:24px;height:24px;margin-top:0}
.fb .sel:nth-child(6) .r{right:11px}
.rc .sel .r{right:9px;top:9px;width:24px;height:24px;margin-top:0}
.nb{display:flex;align-items:center;height:58px;margin-top:19px;padding:0 12px 0 19px;border:1px solid #dae7f9;border-radius:12px;background:#f3f8fe;font-size:14px;letter-spacing:-.005em;color:#4b5678}
.nb i{position:relative;left:-1px;flex:none;width:13px;height:13px;margin-right:14px;border-radius:50%;background:#1369f1;box-shadow:0 0 0 1.3px #fff}
.nb b{margin-right:22px;font-size:15px;font-weight:600;letter-spacing:-.035em;color:#0339e0}
.nb .go{display:flex;align-items:center;justify-content:center;width:131px;height:31px;margin-left:auto;padding:0;border:1px solid #0a60f2;border-radius:3px;background:#1369f1;color:#fff;font-size:13.5px;font-weight:400;letter-spacing:-.045em;text-decoration:none}
.nb .x{display:flex;align-items:center;justify-content:center;width:28px;height:28px;margin-left:10px;border:0;border-radius:8px;background:none;color:#0856e8;cursor:pointer}
.nb .x .ic{position:relative;top:1px;width:24px;height:24px}
.rl{margin-top:16px}
.rtb{table-layout:fixed;width:var(--app-w);border-collapse:separate;border-spacing:0}
.rtb th,.rtb td{padding:13px 0 0;line-height:20px;vertical-align:top;text-align:left;white-space:nowrap}
.rtb th:first-child,.rtb td:first-child{padding-left:16px}
.rtb th:first-child{padding-left:17.9px}
.rtb th{box-sizing:border-box;height:44px;padding-top:13.5px;background:#fcfcfd;font-size:13.5px;font-weight:400;color:#606b85;text-transform:none;letter-spacing:0}
.rtb th:nth-child(2){letter-spacing:-.23px}
.rtb th:nth-child(3){letter-spacing:-.95px}
.rtb th:nth-child(4){letter-spacing:-.65px}
.rtb th:nth-child(6){letter-spacing:-.22px}
.rtb th:nth-child(7){letter-spacing:-.57px}
.rtb th:nth-child(8){letter-spacing:-.42px}
.rtb th:nth-child(9){letter-spacing:-.12px}
.rtb th:nth-child(10){letter-spacing:-.43px}
.rtb th:nth-child(11){letter-spacing:-.26px}
.rtb td{box-sizing:border-box;height:var(--h,46px);padding-top:calc(13px + var(--o,0px));border-top:1px solid #f5f6f8;font-size:14px;font-weight:400;color:#171c2b}
.rtb tr:first-child td{border-top-color:#f1f3f6}
.rtb tr:nth-child(1){--h:45px}
.rtb tr:nth-child(3){--h:45px;--o:-1px}
.rtb tr:nth-child(5){--o:1px}
.rtb tr:nth-child(6){--h:47px}
.rtb tr:nth-child(7){--o:-1px}
.rtb tr:nth-child(8){--h:66px;--o:-1px}
.rtb tr:nth-child(9){--h:47px}
.rtb tr:nth-child(10){--h:56px;--o:1px}
.rtb td:not(.mn){overflow:hidden;text-overflow:ellipsis}
.rtb col:nth-child(1){width:136px}
.rtb col:nth-child(2){width:116px}
.rtb col:nth-child(3){width:64px}
.rtb col:nth-child(4){width:93px}
.rtb col:nth-child(5){width:203px}
.rtb col:nth-child(6){width:126px}
.rtb col:nth-child(7){width:125px}
.rtb col:nth-child(8){width:121px}
.rtb col:nth-child(9){width:82px}
.rtb col:nth-child(10){width:101px}
.rtb col:nth-child(11){width:81px}
.rtb col:nth-child(12){width:113px}
.rtb col:nth-child(13){width:49px}
.rtb td a{text-decoration:none}
.rtb td a:hover{text-decoration:underline}
.rtb .repo{color:#080b16;font-size:14.5px;letter-spacing:-.07em}
.rtb .repo a{color:inherit}
.rtb .pr{margin-left:.8px;color:#145edf;font-size:14.5px;letter-spacing:-.04em}
.rtb .br{color:#2b2c4a;font-size:14.5px;letter-spacing:-.067em}
.rtb .sha-b,.rtb .sha-t{position:relative;top:-1px;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:13.5px;letter-spacing:-.25px;color:#626b83}
.rtb .sha-b{padding:0;border:0;background:none;cursor:pointer}
.sha-b:not([hidden])+.sha-t{display:none}
.sha-b[data-done]::after{content:" \\2713";color:#0e8a55}
.rtb .ev{font-size:14.25px;letter-spacing:-.036em;color:#3e4860}
.rtb .at{font-size:14px;color:#3a4361}
.rtb .ag{font-size:14px;letter-spacing:-.03em;color:#1b243a}
.rtb .du{font-size:14px;font-weight:500;letter-spacing:-.02em;color:#3c4a65}
.rtb .st2{font-size:14.5px;letter-spacing:-.05em;color:#5d657e}
.rtb .au{font-size:14px;letter-spacing:-.025em;color:#171f35}
.rtb .ttl{display:block;overflow:hidden;text-overflow:ellipsis;font-size:14.5px;letter-spacing:-.048em;color:#0b0f1e}
.rtb .rs{display:flex;align-items:center;gap:7px;font-size:12.75px;letter-spacing:-.04em;color:#606981}
.rtb .rs .ic{width:16px;height:16px;color:#7c869f}
.rtb .rs span{overflow:hidden;text-overflow:ellipsis}
.rtb td.mn{padding-left:4px;overflow:visible}
.rtb .mnu summary .ic{position:relative;top:-4px;left:-1.1px;width:24px;height:24px;color:#565f7a}
.rtb td:nth-child(2){padding-left:.8px}
.rtb td:nth-child(4){padding-left:.6px}
.rtb td:nth-child(5){padding-left:1.7px}
.rtb td:nth-child(6){padding-left:1px}
.rtb td:nth-child(9){padding-left:1px}
.rtb td:nth-child(11){padding-left:1.8px}
.rtb td:nth-child(12){padding-left:.8px}
.rtb td:nth-child(8) .nil{width:12.5px;margin-left:1.5px}
.rtb .nil{position:relative;top:.9px}
.rtb .chip{height:24px;margin-left:1px;padding:0 8px;border-radius:5px;font-weight:500;letter-spacing:0}
.rtb .chip.stg{background:#ddeafe;color:#012dd9;letter-spacing:.33px}
.rtb .chip.prev{background:#ede4fe;color:#3113c4}
.rtb .chip.prod{background:#fee4e6;color:#af090c}
.rtb td.empty{padding:40px 0;text-align:center;color:var(--muted)}
.rf2{display:flex;align-items:center;justify-content:space-between;height:69px;padding:1px 17px 0 18px;border-top:1px solid #f1f3f8;font-size:13px;letter-spacing:-.02em;color:#545e7b}
.pgn{display:flex;align-items:center;gap:0}
.pgn a,.pgn span{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border:1px solid transparent;border-radius:5.5px;color:#5d6b84;font-size:12.6px;font-weight:450;text-decoration:none}
.pgn .ic{width:16px;height:16px}
.pgn .gap .ic{width:24px;height:24px}
.pgn .nv{border-color:#e2e6ec;background:#fefefe;color:#4a536e}
.pgn .nv:first-child{margin-right:10px}
.pgn .nv:last-child{margin-left:5.2px}
.pgn span.dis{color:#b6bcc9;border-color:#eceef3}
.pgn a.on{background:#f1f6fe;border-color:#e0ebfc;color:#0955e9;font-weight:600;margin-right:2.6px}
.pgn span.gap{color:#5d6b84}
.scroll{overflow:visible}
@media (max-width:1459px){
.scroll{overflow-x:auto;padding-bottom:160px;margin-bottom:-160px}
.rf2{position:relative;background:#fefefe}
.fb{grid-template-columns:repeat(4,minmax(0,1fr))}
.fb .fs{margin-left:0}
}
@media (max-width:900px){
.runs .ph{flex-wrap:wrap}
.rc{margin-top:0;flex-wrap:wrap}
.fb{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:8px}
.fb .fs{grid-column:1/-1}
.scroll{overflow:visible;padding:0;margin:0}
.rtb,.rtb tbody,.rtb tr,.rtb td{display:block;width:auto}
.rtb{margin:0}
.rtb thead,.rtb col{display:none}
.rtb tr{position:relative;padding:12px 16px;border-top:1px solid #f1f3f6}
.rtb tr:first-child{border-top:0}
.rtb td,.rtb td:not(.mn){display:flex;align-items:center;justify-content:space-between;gap:12px;height:auto;min-height:34px;padding:4px 0;border:0;overflow:visible;white-space:normal}
.rtb td::before{content:attr(data-l);flex:none;font-size:12.5px;font-weight:500;color:#5f6987}
.rtb td.mn{position:absolute;top:12px;right:6px;padding:0;min-height:0}
.rtb td:first-child{padding-right:40px}
.rtb td.mn::before{content:none}
.rtb td.tt{display:block}
.rtb td.tt::before{display:block;margin-bottom:2px}
.rtb td.empty::before{content:none}
.rf2{flex-wrap:wrap;gap:12px;height:auto;padding:14px 16px}
.pgn{gap:8px}
.nb{flex-wrap:wrap;height:auto;padding:12px;gap:8px}
.nb .go{margin-left:0}
}
@media (min-width:901px) and (max-width:1459px){
.rtb th:last-child,.rtb td.mn{position:sticky;right:0;z-index:1;box-shadow:-10px 0 8px -8px rgba(15,20,29,.14)}
.rtb th:last-child{background:#fcfcfd}
.rtb td.mn{background:#fdfdfd}
.rtb td.mn:has(.mnu[open]){z-index:3}
}
@media (max-width:900px){
.rc{align-self:stretch;width:100%}
.rc .sel{flex:1 1 180px;width:auto}
.rc .ob,.fb .sel,.fb .sel select,.rc .sel select,.fb .sel input{min-height:44px}
.rc .ob{display:flex;align-items:center;justify-content:center;flex:1 1 100%}
.rc .sel select,.fb .sel select,.fb .sel input{font-size:16px}
.ob{min-height:44px}
.rtb td.mn{top:6px;right:4px}
.rtb td.mn .mnu summary{width:44px;height:44px;border-radius:10px}
.rtb .mnu summary .ic{top:0;left:0}
.rtb .menu{top:48px}
.rtb .mnu:not([open]) .menu{display:none}
.rtb .mnu[open] .menu{display:grid;gap:8px;min-width:200px}
.rtb .menu a,.rtb .menu button{display:flex;align-items:center;min-height:44px}
.rtb td:first-child{padding:12px 52px 12px 0}
.rtb a.rp{position:relative;margin:0}
.rtb a.rp::after{content:"";position:absolute;top:-8px;right:0;bottom:-8px;left:0}
.rtb a.pr,.rtb .sha-b{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;top:0}
.rtb td:nth-child(3),.rtb td:nth-child(4){padding:4px 0}
.pgn{flex-wrap:wrap}
.pgn a,.pgn span{width:44px;height:44px}
.pgn .nv:first-child,.pgn .nv:last-child{margin:0}
.pgn a.on{margin-right:0}
.nb .go{flex:1 1 auto;width:auto;min-width:131px;height:44px}
.nb .x{width:44px;height:44px}
}
@media (max-width:767px){
.fb{grid-template-columns:minmax(0,1fr)}
.rc .sel{flex-basis:100%}
}
`;

/** The query string that reproduces the filters on page `page` ("" for the plain first page). */
function query(f: RunsFilters, page: number): string {
	const q = new URLSearchParams();
	for (const key of FILTER_KEYS) if (f[key] !== "") q.set(key, f[key]);
	if (f.sort === "oldest") q.set("sort", "oldest");
	if (page > 1) q.set("page", String(page));
	const s = q.toString();
	return s === "" ? "" : `?${s}`;
}

export function nil(): string {
	return `<span class="nil"><span class="sr">${e(D.none)}</span></span>`;
}

/** A select wrapped in its label: the leading icon, the chevron and the name for screen readers. */
function selectBox(name: string, label: string, ic: string, first: string, options: readonly (readonly [string, string])[], current: string): string {
	const opts = [`<option value="">${e(first)}</option>`, ...options.map(([value, text]) => `<option value="${e(value)}"${value === current ? " selected" : ""}>${e(text)}</option>`)];
	return `<label class="sel"><span class="sr">${e(label)}</span>${icon(ic, "l")}<select name="${name}">${opts.join("")}</select>${icon("chevd", "r")}</label>`;
}

function filterBar(v: RunsView): string {
	const f = v.filters;
	const o = v.options;
	const same = (xs: readonly string[]): (readonly [string, string])[] => xs.map((x) => [x, x] as const);
	const search =
		`<label class="sel fs"><span class="sr">${e(L.shaLabel)}</span>${icon("search", "l")}` +
		`<input type="search" name="sha" value="${e(f.sha)}" placeholder="${e(L.shaSearch)}" maxlength="40" autocomplete="off" spellcheck="false"></label>`;
	return (
		`<div class="card fb">` +
		selectBox("repo", L.filterLabels.repo, "monitor", L.allRepos, o.repos.map((r) => [String(r.repo_id), r.full_name] as const), f.repo) +
		selectBox("branch", L.filterLabels.branch, "branch", L.allBranches, same(o.branches), f.branch) +
		selectBox("state", L.filterLabels.state, "circle", L.allStates, o.states.map((s) => [s, L.states[s] ?? s] as const), f.state) +
		selectBox("agent", L.filterLabels.agent, "stack", L.allAgents, o.agents.map((a) => [a.agent_id, a.name] as const), f.agent) +
		selectBox("author", L.filterLabels.author, "user", L.allAuthors, same(o.authors), f.author) +
		selectBox("event", L.filterLabels.event, "bolt", L.allEvents, same(o.events), f.event) +
		`${search}</div>`
	);
}

export function authorCell(login: string | null): string {
	if (login === null) return nil();
	const initial = e((Array.from(login)[0] ?? "?").toUpperCase());
	return (
		`<span class="au"><span class="av"><span class="ini">${initial}</span>` +
		`<img src="https://github.com/${encodeURIComponent(login)}.png?size=56" alt="" width="26" height="26" loading="lazy" referrerpolicy="no-referrer"></span>${e(login)}</span>`
	);
}

export function refCell(run: RunListRow): string {
	if (run.pr_number === null) return `<span class="br" title="${e(branchLabel(run.ref))}">${e(branchLabel(run.ref))}</span>`;
	const text = e(L.prShort(run.pr_number));
	if (run.repo_name === null) return `<span class="pr">${text}</span>`;
	return `<a class="pr" href="${e(D.githubPullUrl(run.repo_name, run.pr_number))}" rel="noopener noreferrer">${text}</a>`;
}

export function shaCell(sha: string): string {
	const short = e(sha.slice(0, 7));
	return `<button class="sha-b" type="button" data-copy="${e(sha)}" title="${e(L.copySha)}" hidden>${short}</button><span class="sha-t">${short}</span>`;
}

export function durationCell(run: RunListRow, now: number): string {
	let ms = run.duration_ms;
	if (ms === null && run.finished_at === null && run.started_at !== null && Object.hasOwn(LIVE_STATES, run.state)) ms = Math.max(0, now - run.started_at);
	return ms === null ? nil() : e(durationText(ms));
}

function runRow(v: RunsView, base: string, run: RunListRow): string {
	const href = runHref(base, run);
	const c = L.cols;
	const items: [string, string][] = [[href, D.menu.viewRun]];
	if (run.repo_name !== null) items.push([D.githubCommitUrl(run.repo_name, run.sha), D.menu.openOnGithub]);
	const title = run.commit_title === null ? nil() : `<span class="ttl" title="${e(run.commit_title)}">${e(run.commit_title)}</span>`;
	const reason = run.reason === null || run.reason === "" ? "" : `<span class="rs">${icon("info")}<span title="${e(run.reason)}">${e(run.reason)}</span></span>`;
	const env = run.env === null || run.env === "" ? nil() : `<span class="chip ${Object.hasOwn(ENV_CLASS, run.env) ? ENV_CLASS[run.env] : ""}">${e(run.env)}</span>`;
	const cells: [string, string, string][] = [
		["", c.state, runPill(run.state, href)],
		["repo", c.repo, `<span title="${e(run.repo_name ?? D.unknownRepo)}">${e(shortRepo(run.repo_name))}</span>`],
		["", c.ref, refCell(run)],
		["", c.sha, shaCell(run.sha)],
		["tt", c.title, `${title}${reason}`],
		["", c.author, authorCell(run.author_login)],
		["ev", c.event, run.event === "" ? nil() : e(run.event.replaceAll("_", " "))],
		["", c.env, env],
		["at", c.attempt, String(run.attempt)],
		["ag", c.agent, run.agent_name === null ? nil() : e(run.agent_name)],
		["du", c.duration, durationCell(run, v.now)],
		["st2", c.started, run.started_at === null ? nil() : agoHtml(run.started_at, v.now)],
	];
	const tds = cells.map(([cls, label, html]) => `<td${cls === "" ? "" : ` class="${cls}"`} data-l="${e(label)}">${html}</td>`).join("");
	return `<tr>${tds}<td class="mn">${rowMenu(items, href)}</td></tr>`;
}

function runTable(v: RunsView, base: string): string {
	const heads = Object.values(L.cols).map((label) => `<th>${e(label)}</th>`);
	const head = `<thead><tr>${heads.join("")}<th><span class="sr">${e(D.menu.label)}</span></th></tr></thead>`;
	const cols = `<colgroup>${"<col>".repeat(13)}</colgroup>`;
	const empty = v.total === 0 && FILTER_KEYS.every((k) => v.filters[k] === "") ? D.noRuns : L.noMatch;
	const body = v.runs.length === 0 ? `<tr><td class="empty" colspan="13">${e(empty)}</td></tr>` : v.runs.map((run) => runRow(v, base, run)).join("");
	return `<div class="scroll"><table class="rtb">${cols}${head}<tbody>${body}</tbody></table></div>`;
}

/** The pages to show: the current one with a neighbour on each side, the first page, and ellipses where pages are skipped. */
function pageWindow(page: number, pages: number): (number | null)[] {
	const start = Math.max(1, Math.min(page - 1, pages - 2));
	const end = Math.min(pages, start + 2);
	const out: (number | null)[] = [];
	if (start > 1) out.push(1);
	if (start > 2) out.push(null);
	for (let p = start; p <= end; p++) out.push(p);
	if (end < pages) out.push(null);
	return out;
}

function pager(v: RunsView, base: string): string {
	const pages = Math.max(1, Math.ceil(v.total / v.perPage));
	if (pages === 1) return "";
	const at = (p: number): string => `${base}/runs${query(v.filters, p)}`;
	const prev =
		v.page <= 1 ? `<span class="nv dis" aria-hidden="true">${icon("back")}</span>` : `<a class="nv" href="${e(at(v.page - 1))}" aria-label="${e(L.previousPage)}">${icon("back")}</a>`;
	const next =
		v.page >= pages ? `<span class="nv dis" aria-hidden="true">${icon("arrow")}</span>` : `<a class="nv" href="${e(at(v.page + 1))}" aria-label="${e(L.nextPage)}">${icon("arrow")}</a>`;
	const nums = pageWindow(v.page, pages).map((p) => {
		if (p === null) return `<span class="gap" aria-hidden="true">${icon("ellipsis")}</span>`;
		return p === v.page
			? `<a class="on" href="${e(at(p))}" aria-current="page" aria-label="${e(L.page(p))}">${p}</a>`
			: `<a href="${e(at(p))}" aria-label="${e(L.page(p))}">${p}</a>`;
	});
	return `<nav class="pgn" aria-label="${e(L.pagination)}">${prev}${nums.join("")}${next}</nav>`;
}

function liveBanner(v: RunsView, base: string): string {
	return (
		`<div class="nb" data-newer="${base}/runs/newer" data-after="${v.newest}" data-one="${e(L.newRunsOne)}" data-many="${e(L.newRunsMany)}" role="status" hidden>` +
		`<i></i><b data-count>${e(L.newRunsMany)}</b><span>${e(L.newRunsBody)}</span>` +
		`<a class="go" href="${e(`${base}/runs${query(v.filters, 1)}`)}">${e(L.showNewRuns)}</a>` +
		`<button class="x" type="button" data-dismiss aria-label="${e(L.dismiss)}">${icon("x")}</button></div>`
	);
}

function sortSelect(v: RunsView): string {
	const options = Object.entries(L.sort).map(([value, text]) => `<option value="${value}"${v.filters.sort === value ? " selected" : ""}>${e(text)}</option>`);
	return `<label class="sel"><span class="sr">${e(L.sortLabel)}</span><select name="sort">${options.join("")}</select>${icon("chevd", "r")}</label>`;
}

export function runsListPage(v: RunsView): Promise<Response> {
	const base = `/app/${v.account.id}`;
	const active = FILTER_KEYS.some((k) => v.filters[k] !== "");
	const reset = active ? `<a class="ob" href="${base}/runs${v.filters.sort === "oldest" ? "?sort=oldest" : ""}">${e(L.reset)}</a>` : "";
	const controls = `<div class="rc">${reset}<span class="live" data-live hidden><i></i>${e(L.live)}</span>${sortSelect(v)}</div>`;
	const form =
		`<form class="rf" id="runs-filter" method="get" action="${base}/runs" data-auto role="search" aria-label="${e(L.filters)}">` +
		`<div class="ph"><div><h1>${e(L.title)}</h1><p class="sub">${e(L.subtitle)}</p></div>${controls}</div>` +
		`${filterBar(v)}<noscript><button class="ob" type="submit">${e(L.apply)}</button></noscript></form>`;
	const main =
		`${accountNav(v.accounts, v.account.id)}${form}${liveBanner(v, base)}` +
		`<section class="card rl">${runTable(v, base)}<div class="rf2"><span>${e(L.showing(v.runs.length))}</span>${pager(v, base)}</div></section>`;
	return appPage({
		title: v.account.account_login,
		bodyClass: "runs",
		main,
		viewer: viewerOf(v, "runs"),
		init: initOf(v),
		css: CSS,
		icons: PAGE_ICONS,
		script: PAGE_SCRIPT,
		avatars: true,
	});
}
