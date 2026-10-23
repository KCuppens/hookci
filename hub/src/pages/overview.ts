// The overview tab: what needs attention, four numbers, the latest runs, the agents and the setup checklist.
// Built on the dashboard chrome (dashboard.ts); every dynamic value goes through escapeHtml.

import type { AgentRow } from "../db/agents";
import type { InstallationRow } from "../db/installations";
import type { OverviewData } from "../db/overview";
import type { RunListRow } from "../db/runs";
import { QUOTAS } from "../quotas";
import { upgradeHint } from "../slack/home";
import { S } from "../strings";
import {
	accountNav,
	agoHtml,
	appPage,
	branchLabel,
	type DashboardChrome,
	durationText,
	initOf,
	PAGE_SCRIPT,
	rowMenu,
	runHref,
	shortRepo,
	spanText,
	statusCircle,
	viewerOf,
} from "./dashboard";
import { escapeHtml } from "./layout";
import { TRACED_ICONS } from "./overview-icons";
import { icon } from "./shell";

const D = S.dashboard;
const O = D.overview;
const e = escapeHtml;

export type OverviewRange = "today" | "week" | "month";

export interface OverviewView {
	account: InstallationRow;
	accounts: readonly InstallationRow[];
	login: string;
	chrome?: DashboardChrome;
	cookies?: string[];
	now: number;
	range: OverviewRange;
	overview: OverviewData;
	runs: readonly RunListRow[];
	agents: readonly AgentRow[];
	/** The newest released agent version ("" until the first release); agents older than it get the upgrade chip. */
	latestAgentVersion: string;
}

const OVERVIEW_ICONS: Record<string, string> = {
	...TRACED_ICONS,
	arrd: '<path d="M12 5v14M6.5 13.5 12 19l5.5-5.5"/>',
	arru: '<path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/>',
	slackc:
		'<path fill="#36c5f0" stroke="none" d="M9.2 3a1.9 1.9 0 0 0-1.9 1.9 1.9 1.9 0 0 0 1.9 1.9h1.9V4.9A1.9 1.9 0 0 0 9.2 3zm0 5.1H4.1a1.9 1.9 0 0 0 0 3.8h5.1a1.9 1.9 0 0 0 0-3.8z"/>' +
		'<path fill="#2eb67d" stroke="none" d="M21 9.9A1.9 1.9 0 0 0 19.1 8a1.9 1.9 0 0 0-1.9 1.9v1.9h1.9A1.9 1.9 0 0 0 21 9.9zm-5.1 0V4.8a1.9 1.9 0 0 0-3.8 0v5.1a1.9 1.9 0 0 0 3.8 0z"/>' +
		'<path fill="#ecb22e" stroke="none" d="M14.8 21a1.9 1.9 0 0 0 1.9-1.9 1.9 1.9 0 0 0-1.9-1.9h-1.9v1.9a1.9 1.9 0 0 0 1.9 1.9zm0-5.1h5.1a1.9 1.9 0 0 0 0-3.8h-5.1a1.9 1.9 0 0 0 0 3.8z"/>' +
		'<path fill="#e01e5a" stroke="none" d="M3 14.1a1.9 1.9 0 0 0 1.9 1.9 1.9 1.9 0 0 0 1.9-1.9v-1.9H4.9A1.9 1.9 0 0 0 3 14.1zm5.1 0v5.1a1.9 1.9 0 0 0 3.8 0v-5.1a1.9 1.9 0 0 0-3.8 0z"/>',
};

const CSS = `
body.overview{--ink:#080b16;--muted:#646f8a;--line:#ecf0f3;--line-2:#eef0f4;background:#f8f9fa;text-rendering:geometricPrecision}
.rng{margin-top:9px}
.rng label{position:relative;display:block}
.rng select{appearance:none;width:127px;height:37px;padding:0 30px 0 38px;border:1px solid #e1e5ec;border-radius:10px;background:#fff;color:var(--ink);font:inherit;font-size:13px;font-weight:500;letter-spacing:-.04em;cursor:pointer}
.rng .ic{position:absolute;color:#202a3b;pointer-events:none}
.rng .ic.l{left:10px;top:7px;width:22px;height:22px}
.rng .ic.r{right:12px;top:13px;width:13px;height:13px}
.overview .card{overflow:visible;border-color:#edf0f4;border-radius:8px;background:#fbfbfd;box-shadow:none}
.overview .stack-gap>*+*{margin-top:14px}
.overview .stack-gap>.card+.card{margin-top:17px}
.att{border:1px solid #f6e9ed;border-radius:8px;background:#fcf1f3}
.att .ah{display:flex;align-items:center;gap:12px;padding:16px 0 0 21px}
.att .bang{display:grid;place-items:center;width:25px;height:25px;border-radius:50%;background:#ef3b3b;color:#fff}
.att .bang .ic{width:25px;height:25px}
.att h2{position:relative;top:1.5px;font-size:17px;font-weight:600;letter-spacing:-.02em}
.att .cnt{display:grid;place-items:center;width:25px;height:25px;border-radius:50%;background:#ef3b3b;color:#fff;font-size:13px;font-weight:500}
.att .ag{display:grid;grid-template-columns:334fr 289fr 288fr;margin-top:18px;padding-bottom:19px}
.att .ai{display:grid;grid-template-columns:46px minmax(0,1fr);column-gap:21px;align-content:start;padding-left:25px}
.att .ai+.ai{position:relative;padding-left:25px;column-gap:20px}
.att .ai+.ai::before{content:"";position:absolute;left:0;top:3px;width:1px;height:95px;background:#e8e1e6}
.att .ai.gh{grid-template-columns:33px minmax(0,1fr);padding-left:34px;column-gap:20px}
.att .tl{position:relative;top:1px;left:1px;display:grid;place-items:center;width:46px;height:46px;margin-top:-3px;border-radius:50%;background:#fbe7ea;color:#d93f4b}
.att .ai+.ai .tl{left:2.4px}
.att .tl .ic{width:46px;height:46px}
.att .gh .tl{top:3px;left:0;width:33px;height:33px;margin-top:2px;background:none;color:#0e121a}
.att .gh .tl .ic{width:33px;height:33px}
.att .tx{min-width:0;margin-top:-1px}
.att .off .tx{max-width:150px}
.att .ai:first-child .ob{margin-left:5px}
.att .ai+.ai .ob{margin-left:1.4px}
.att .ai.gh .ob{margin-left:1.7px}
.att b{position:relative;top:1.3px;display:block;margin-bottom:3px;font-size:13.5px;font-weight:600;letter-spacing:-.02em;line-height:20px}
.att .off b{top:2.4px}
.att .d{display:block;color:var(--muted);font-size:12.75px;font-weight:400;letter-spacing:-.02em;line-height:19px;overflow-wrap:anywhere}
.att .off .d{position:relative;top:4px}
.att .gh .d{position:relative;top:1px}
.att .ob{grid-column:2;justify-self:start;gap:9px;margin-top:15px;height:31px;padding:0 11.5px;border-color:#e6e9f0;border-radius:4px;background:#fdfdfe;font-size:13px;font-weight:500;letter-spacing:-.03em}
.att .ob .ic{width:13px;height:13px}
.overview .ch a .ic{width:14px;height:14px}
.att.ok{padding:18px 22px;border-color:#d9efe2;background:#f1fbf5}
.att.ok .bang{background:#16a34a}
.att .clear{display:flex;align-items:center;gap:12px;color:#15803d;font-size:15px;font-weight:500}
.overview .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;margin-top:15px}
.overview .stat{height:162px;padding:16px 22px 0}
.stat .sh{display:flex;align-items:center;gap:13px;height:36px;font-size:13.25px;font-weight:500;letter-spacing:-.035em}
.stat .lb{position:relative;top:1px}
.stat .ci{position:relative;top:3.5px;left:-2px;display:grid;place-items:center;width:35px;height:35px;border-radius:50%;background:#e4f4ec;color:#17a35c}
.stat:nth-child(4) .ci{top:2.5px}
.stat .ci.tq{background:#e6f5f4}
.stat .ci.bl{background:#eaf1fb}
.stat .ci .ic{width:35px;height:35px}
.stat .v{display:flex;align-items:baseline;gap:6px;height:36px;margin-top:16px;font-size:28.5px;font-weight:700;letter-spacing:-.07em;line-height:36px}
.stat .v:has(+.n){margin-top:22px}
.stat .v+.n{margin-top:4px}
.stat .v small{color:#3b4458;font-size:24.5px;font-weight:400;letter-spacing:0;line-height:1}
.stat .v .delta{align-self:center;margin-left:11px;color:#16a34a;font-size:13.6px;font-weight:500;letter-spacing:0}
.stat .v .delta.up{color:#dc2626}
.stat .v .delta .ic{display:inline-block;vertical-align:-2px;width:13px;height:13px;margin-right:3px}
.stat .bar{display:block;overflow:hidden;height:7px;margin-top:6px;border-radius:4px;background:#e5e7eb}
.stat .bar svg{display:block;width:100%;height:100%}
.stat .bar rect{fill:#10b45f}
.stat .n{position:relative;top:1.7px;margin-top:6px;color:var(--muted);font-size:12.75px;font-weight:400;letter-spacing:-.025em;line-height:20px}
.stat:nth-child(4) .n{top:-.7px}
.overview .sc .ic{width:24px;height:24px}
.overview .ch{height:57px;padding:0 16px 0 20px;border-bottom:0}
.overview .ch.rc{height:61px}
.overview .ch.sup{height:53px}
.overview .ch h2{position:relative;font-size:20px;font-weight:700;letter-spacing:-.03em}
.overview .sup h2{top:1.5px}
.overview .ch a{position:relative;color:#2f64b8;font-size:13.5px;font-weight:400;letter-spacing:-.035em}
.overview .rc h2{top:-.5px}
.overview .rc a{top:2px}
.overview #agents .ch h2{top:1.3px}
.overview #agents .ch a{top:3.4px}
.overview .sup a{top:4.2px}
.overview .ch a .ic{margin-left:2px}
.overview .tw{padding:0 20px 16px}
.overview table{table-layout:fixed}
.overview th{height:32px;padding:2px 0 0 6px;border-top:1px solid #edf0f4;border-bottom:1px solid #edf0f4;background:#f7f8fb;color:var(--muted);font-size:12.25px;font-weight:500;letter-spacing:-.02em}
.overview td{height:40.5px;padding:3px 0 0 6px;border-top:0;border-bottom:1px solid #eef0f4;font-size:13px;font-weight:500;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.overview #agents .ch{height:56px}
.overview #agents .tw{padding-bottom:11px}
.overview .stack-gap>#agents+.card{margin-top:17px}
.overview .ag2 th{height:31px}
.overview .ag2 td{height:42px}
.overview .ag2 tr:first-child td{height:41px}
.overview .rn tr:nth-child(-n+3) td{height:40px}
.overview .rn tr:nth-child(4) td{height:41px}
.overview .rn tr:nth-child(5) td{height:41.5px}
.overview tbody tr:last-child td{border-bottom:0}
.overview td.k{font-size:14px;font-weight:400;letter-spacing:-.04em}
.overview td a{color:inherit}
.overview td a.pr{color:#2f64b8}
.overview td.muted{color:#4b5365}
.overview td.br{color:var(--muted);font-size:13.5px;letter-spacing:-.025em}
.overview td:nth-child(4){font-size:14px;font-weight:400;letter-spacing:-.045em}
.overview .ag2 td.k{font-size:13.25px;font-weight:500;letter-spacing:-.005em}
.overview .ag2 td:nth-child(3),.overview .ag2 td:nth-child(4),.overview .ag2 td:nth-child(5){font-size:13.5px;font-weight:400;letter-spacing:-.025em}
.overview .c1{width:77px}.overview .c2{width:174px}.overview .c3{width:208px}.overview .c4{width:122px}.overview .c5{width:115px}.overview .c6{width:120px}
.overview .a1{width:82px}.overview .a2{width:162px}.overview .a3{width:261px}.overview .a4{width:181px}.overview .a5{width:126px}
.overview .dot{position:relative;top:2px;width:13.4px;height:13.4px;margin-left:0;background:#ef2a31}
.overview .dot.on{background:#13ae6e}
.overview .chip.up{position:relative;top:-1px;margin-left:28.5px;padding:0 7px;border-radius:999px;background:#fdefd3;color:#b3541a;font-size:12px;font-weight:500;letter-spacing:-.035em;line-height:21px}
.overview td.mn{padding:0 3px 0 0;text-align:right;overflow:visible}
.su{list-style:none;padding:0 18px 10px 20px}
.su li{display:flex;align-items:center;gap:27px;height:63.3px;padding:0 0 0 7px;border-top:1px solid #eef0f4}
.su li.act{height:69px}
.su li:first-child{border-top:1px solid #e9ecf1}
.su li:nth-child(1){height:62.5px}
.su li:nth-child(2){height:63.8px}
.su .sk{display:grid;place-items:center;flex:none;width:28px;height:28px;border:2px solid #8b92a5;border-radius:50%;color:#fff}
.su .sk.done{border-color:#13ab6d;background:#13ab6d}
.su .sk .ic{width:28px;height:28px;margin:-2px}
.su .tx{flex:1;min-width:0}
.su b{position:relative;display:block;font-size:14.25px;font-weight:600;letter-spacing:-.025em;line-height:20px}
.su .d{position:relative;display:block;color:var(--muted);font-size:12.25px;font-weight:400;letter-spacing:-.025em;line-height:18px}
.su li:nth-child(1) b{top:1px}
.su li:nth-child(1) .d{top:2px}
.su li:nth-child(2) b,.su li:nth-child(2) .d{top:3px}
.su li:nth-child(3) .d{top:1px}
.su li:nth-child(n+2) .d{letter-spacing:-.019em}
.su li:nth-child(n+3) b{letter-spacing:-.014em}
.su .ob{justify-content:center;gap:5px;min-width:139px;height:38px;padding:0 10px 0 12px;border-color:#e7eaf2;border-radius:5.4px;background:#fcfdfe;font-size:13.25px;font-weight:500;letter-spacing:-.015em}
.su .ob.dk{padding:4px 14.6px 0 12px;border-color:#111822;border-radius:7px;background:#101823}
.su .ob:not(.dk){padding:2px 17px 0 12px}
.su .ob .ic{width:28px;height:28px;margin:-4px 0 -4px -3px}
@media (max-width:900px){
.att .ag{grid-template-columns:1fr}
.att .ai,.att .ai+.ai,.att .ai.gh{grid-template-columns:46px minmax(0,1fr);column-gap:20px;padding:12px 20px 12px 22px;border-left:0}
.att .ai:first-child .ob,.att .ai+.ai .ob,.att .ai.gh .ob{margin-left:0}
.att .off .tx{max-width:none}
.overview .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
.att .ai+.ai::before{left:20px;right:20px;top:0;width:auto;height:1px}
.su li,.su li.act,.su li:nth-child(1),.su li:nth-child(2){height:auto;min-height:63px;padding:12px 0 12px 7px;flex-wrap:wrap;row-gap:10px}
.su .tx{flex:1 1 180px}
.su li:nth-child(n+2) b,.su li:nth-child(n+2) .d{letter-spacing:-.025em}
.overview table{table-layout:auto;min-width:0}
.overview .tw{overflow:visible}
.overview .ph{flex-direction:column;align-items:stretch;gap:16px}
.rng{margin-top:0}
.rng select{width:100%;height:44px;font-size:16px}
.rng .ic.l{top:11px}
.rng .ic.r{top:15px}
.overview .stat{height:auto;padding-bottom:16px}
.stat .v{flex-wrap:wrap;height:auto;min-height:36px}
.overview .ch,.overview .ch.rc,.overview .ch.sup,.overview #agents .ch{height:auto;min-height:57px;padding:4px 16px 4px 20px}
.overview .ch a,.overview .rc a,.overview .sup a,.overview #agents .ch a{top:0}
}
@media (max-width:900px){
.overview .tw{padding:0 16px 8px}
.overview table,.overview tbody,.overview tr,.overview td{display:block}
.overview thead,.overview colgroup{display:none}
.overview tbody tr{position:relative;padding:8px 0;border-bottom:1px solid #eef0f4}
.overview tbody tr:last-child{border-bottom:0}
.overview :is(.rn,.ag2) tbody tr:nth-child(n) td{display:flex;align-items:center;justify-content:space-between;gap:12px;height:auto;min-height:32px;padding:4px 0;border:0;overflow:visible;white-space:normal;overflow-wrap:anywhere;text-align:right;text-overflow:clip}
.overview :is(.rn,.ag2) tbody tr:nth-child(n) td::before{content:attr(data-label);flex:none;color:var(--muted);font-size:12.5px;font-weight:500;letter-spacing:0;text-align:left}
.overview :is(.rn,.ag2) tbody tr:nth-child(n) td:first-child{min-height:44px;padding-right:44px}
.overview :is(.rn,.ag2) tbody tr:nth-child(n) td.mn{position:absolute;top:4px;right:-8px;display:block;min-height:0;padding:0}
.overview :is(.rn,.ag2) tbody tr:nth-child(n) td.mn::before{content:none}
.overview .chip.up{margin-left:8px}
.overview .vl{flex:1;min-width:0;text-align:right}
.overview td.k a,.overview .vl a.pr{display:inline-flex;align-items:center;justify-content:flex-end;min-width:44px;min-height:44px}
}
@media (max-width:520px){
.overview .stats{grid-template-columns:1fr}
.att .ob,.su li>.ob{flex:0 0 100%;justify-self:stretch;justify-content:center}
}
`;

function attentionItem(iconName: string, title: string, detail: readonly string[], link: [string, string], cls = ""): string {
	const lines = detail.map((d) => `<span class="d">${e(d)}</span>`).join("");
	return `<div class="ai${cls}"><span class="tl">${icon(iconName)}</span><div class="tx"><b>${e(title)}</b>${lines}</div><a class="ob" href="${e(link[0])}">${e(link[1])}${icon("arrow")}</a></div>`;
}

function attentionPanel(v: OverviewView, base: string): string {
	const offline = v.agents.filter((a) => a.status === "offline");
	const watches = v.overview.brokenWatches;
	const items: string[] = [];
	if (v.overview.gatedRuns > 0) {
		items.push(attentionItem("fork", O.gated(v.overview.gatedRuns), [O.gatedBody], [`${base}/runs?state=gated`, O.reviewRuns]));
	}
	const first = offline[0];
	if (first !== undefined) {
		const seen = first.last_seen_at === null ? O.agentNeverSeen(first.name) : O.agentOfflineBody(first.name, spanText(first.last_seen_at, v.now));
		items.push(attentionItem("dbb", O.agentsOffline(offline.length), [seen], [`${base}/agents`, O.viewAgents], " off"));
	}
	const watch = watches[0];
	if (watch !== undefined) {
		const lines = [shortRepo(watch.repo_name), watch.broken_reason ?? ""].filter((l) => l !== "");
		items.push(attentionItem("ghm", O.watchesBroken(watches.length), lines, [`${base}/repositories`, O.viewRepository], " gh"));
	}
	if (items.length === 0) {
		return `<section class="att ok"><div class="clear"><span class="bang">${icon("check")}</span>${e(O.allClear)}</div></section>`;
	}
	return `<section class="att"><div class="ah"><span class="bang">${icon("bang")}</span><h2>${e(O.attention)}</h2><span class="cnt">${items.length}</span></div><div class="ag">${items.join("")}</div></section>`;
}

function bar(percent: number): string {
	const width = Math.max(0, Math.min(100, percent));
	return `<span class="bar"><svg viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect width="${width}" height="6" rx="3"/></svg></span>`;
}

function statCard(iconName: string, label: string, value: string, extra: string, tint = ""): string {
	return `<div class="card stat"><div class="sh"><span class="ci${tint}">${icon(iconName)}</span><span class="lb">${e(label)}</span></div><div class="v">${value}</div>${extra}</div>`;
}

function statCards(v: OverviewView): string {
	const o = v.overview;
	const total = v.agents.length;
	const online = v.agents.filter((a) => a.status === "online").length;
	const agentsExtra = total === 0 ? `<div class="n">${e(O.noAgentsYet)}</div>` : `${bar((online / total) * 100)}<div class="n">${e(O.percentOnline(Math.round((online / total) * 100)))}</div>`;
	const limit = QUOTAS.runsPerDay;
	const finished = o.passed + o.failed;
	const passExtra =
		finished === 0
			? `<div class="n">${e(O.noFinishedRuns)}</div>`
			: `${bar((o.passed / finished) * 100)}<div class="n">${e(O.passedFailed(o.passed, o.failed))}</div>`;
	let delta = "";
	if (o.medianMs !== null && o.previousMedianMs !== null && o.previousMedianMs > 0) {
		const pct = Math.round(((o.medianMs - o.previousMedianMs) / o.previousMedianMs) * 100);
		if (pct !== 0) delta = `<span class="delta${pct > 0 ? " up" : ""}">${icon(pct < 0 ? "arrd" : "arru")}${Math.abs(pct)}%</span>`;
	}
	const medianExtra = o.previousMedianMs === null ? "" : `<div class="n">${e(O.vsPrevious)}</div>`;
	return `<div class="stats">${[
		statCard("db", O.agentsOnline, total === 0 ? e(D.none) : `<span>${online}</span> <small>/ ${total}</small>`, agentsExtra, " tq"),
		statCard("tri", O.runsToday, `<span>${o.runsToday}</span> <small>/ ${limit}</small>`, `${bar((o.runsToday / limit) * 100)}<div class="n">${e(O.remaining(Math.max(0, limit - o.runsToday)))}</div>`),
		statCard("pass", O.passRate, finished === 0 ? e(D.none) : `${Math.round((o.passed / finished) * 100)}%`, passExtra),
		statCard("clk", O.median, `<span>${e(durationText(o.medianMs))}</span>${delta}`, medianExtra, " bl"),
	].join("")}</div>`;
}

function rangeForm(v: OverviewView, base: string): string {
	const options = (Object.keys(O.range) as OverviewRange[]).map((k) => `<option value="${k}"${v.range === k ? " selected" : ""}>${e(O.range[k] ?? k)}</option>`).join("");
	return (
		`<form class="rng" method="get" action="${base}" data-auto><label><span class="sr">${e(O.rangeLabel)}</span>${icon("cal", "l")}` +
		`<select name="range">${options}</select>${icon("chevd", "r")}</label><noscript><button class="ob" type="submit">${e(O.apply)}</button></noscript></form>`
	);
}

function recentRuns(v: OverviewView, base: string): string {
	const rows = v.runs
		.map((run) => {
			const href = runHref(base, run);
			const pr =
				run.pr_number === null
					? e(branchLabel(run.ref))
					: `${run.repo_name === null ? `<span class="pr">${e(O.prShort(run.pr_number))}</span>` : `<a class="pr" href="${e(D.githubPullUrl(run.repo_name, run.pr_number))}" rel="noopener noreferrer">${e(O.prShort(run.pr_number))}</a>`}${run.commit_title === null ? "" : ` ${e(run.commit_title)}`}`;
			const items: [string, string][] = [[href, D.menu.viewRun]];
			if (run.repo_name !== null) items.push([D.githubCommitUrl(run.repo_name, run.sha), D.menu.openOnGithub]);
			return (
				`<tr><td data-label="${e(D.cols.status)}">${statusCircle(run.state)}</td><td class="k" data-label="${e(D.cols.repo)}" title="${e(run.repo_name ?? D.unknownRepo)}"><a href="${href}">${e(shortRepo(run.repo_name))}</a></td>` +
				`<td class="muted br" data-label="${e(O.branchPr)}"><span class="vl">${pr}</span></td><td class="muted" data-label="${e(D.cols.commit)}">${e(run.sha.slice(0, 7))}</td><td class="muted" data-label="${e(D.cols.duration)}">${e(durationText(run.duration_ms))}</td><td class="muted" data-label="${e(D.cols.started)}">${agoHtml(run.started_at, v.now)}</td>` +
				`<td class="mn">${rowMenu(items, href)}</td></tr>`
			);
		})
		.join("");
	const cols = [D.cols.status, D.cols.repo, O.branchPr, D.cols.commit, D.cols.duration, D.cols.started];
	const head = `<thead><tr>${cols.map((c) => `<th>${e(c)}</th>`).join("")}<th></th></tr></thead>`;
	const colgroup = `<colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5"><col class="c6"><col></colgroup>`;
	const body = v.runs.length === 0 ? `<p class="empty">${e(O.noRunsInRange)}</p>` : `<div class="tw"><table class="rn">${colgroup}${head}<tbody>${rows}</tbody></table></div>`;
	return `<section class="card"><div class="ch rc"><h2>${e(O.recentRuns)}</h2><a href="${base}/runs">${e(O.viewAllRuns)}${icon("arrow")}</a></div>${body}</section>`;
}

function agentsCard(v: OverviewView, base: string): string {
	const rows = v.agents
		.map((a) => {
			const running = v.overview.runningByAgent[a.agent_id] ?? 0;
			const upgrade = upgradeHint(a.protocol_version, a.agent_version, v.latestAgentVersion) !== undefined;
			const version = a.agent_version === null ? e(D.none) : e(a.agent_version.replace(/^v/, ""));
			const seen = a.last_seen_at === null ? e(D.agentNeverSeen) : agoHtml(a.last_seen_at, v.now);
			return (
				`<tr><td data-label="${e(D.cols.status)}"><span class="dot${a.status === "online" ? " on" : ""}" title="${e(a.status)}"></span><span class="sr">${e(a.status)}</span></td><td class="k" data-label="${e(D.cols.name)}">${e(a.name)}</td>` +
				`<td data-label="${e(D.cols.version)}">${version}${upgrade ? `<span class="chip up">${e(S.dashboard.agentsPage.upgrade)}</span>` : ""}</td><td class="muted" data-label="${e(O.lastSeen)}">${seen}</td><td class="muted" data-label="${e(O.runningJobs)}">${running}</td>` +
				`<td class="mn">${rowMenu([[`${base}/agents`, D.menu.viewAgents]], null)}</td></tr>`
			);
		})
		.join("");
	const cols = [D.cols.status, D.cols.name, D.cols.version, O.lastSeen, O.runningJobs];
	const head = `<thead><tr>${cols.map((c) => `<th>${e(c)}</th>`).join("")}<th></th></tr></thead>`;
	const colgroup = `<colgroup><col class="a1"><col class="a2"><col class="a3"><col class="a4"><col class="a5"><col></colgroup>`;
	const body = v.agents.length === 0 ? `<p class="empty">${e(D.noAgents)}</p>` : `<div class="tw"><table class="ag2">${colgroup}${head}<tbody>${rows}</tbody></table></div>`;
	return `<section class="card" id="agents"><div class="ch"><h2>${e(D.agents)}</h2><a href="${base}/agents">${e(O.viewAllAgents)}${icon("arrow")}</a></div>${body}</section>`;
}

function setupCard(v: OverviewView, base: string): string {
	const o = v.overview;
	const guide = S.site.docsUrl;
	const steps: [boolean, string, string, string, string][] = [
		[o.setup.agents > 0, O.stepPair, O.stepPairBody, guide, ""],
		[o.setup.configuredRuns > 0, O.stepConfig, O.stepConfigBody, guide, ""],
		[o.setup.bindings > 0, O.stepBind, O.stepBindBody, `${base}/repositories`, ""],
		[o.setup.slack > 0, O.stepSlack, O.stepSlackBody, `/slack/install?installation_id=${v.account.id}`, "slackc"],
	];
	let firstPending = true;
	const rows = steps
		.map(([done, title, body, href, ic]) => {
			let action = "";
			if (!done) {
				const dark = firstPending;
				firstPending = false;
				action = `<a class="ob${dark ? " dk" : ""}" href="${e(href)}"${href === guide ? ' rel="noopener noreferrer"' : ""}>${ic === "" ? "" : icon(ic)}${e(href === guide ? O.openGuide : title)}</a>`;
			}
			return `<li${done ? "" : ' class="act"'}><span class="sk${done ? " done" : ""}">${done ? icon("chk") : ""}</span><div class="tx"><b>${e(title)}</b><span class="d">${e(body)}</span></div>${action}</li>`;
		})
		.join("");
	return `<section class="card"><div class="ch sup"><h2>${e(O.setup)}</h2><a href="${e(guide)}" rel="noopener noreferrer">${e(O.viewGuide)}${icon("arrow")}</a></div><ul class="su">${rows}</ul></section>`;
}

export function overviewPage(v: OverviewView): Promise<Response> {
	const base = `/app/${v.account.id}`;
	const main =
		`${accountNav(v.accounts, v.account.id)}<div class="ph"><div><h1>${e(O.title)}</h1><p class="sub">${e(O.subtitle)}</p></div>${rangeForm(v, base)}</div>` +
		`<div class="stack-gap">${attentionPanel(v, base)}${statCards(v)}${recentRuns(v, base)}${agentsCard(v, base)}${setupCard(v, base)}</div>`;
	return appPage({
		title: v.account.account_login,
		bodyClass: "overview",
		main,
		viewer: viewerOf(v, "overview"),
		init: initOf(v),
		css: CSS,
		icons: OVERVIEW_ICONS,
		script: PAGE_SCRIPT,
	});
}
