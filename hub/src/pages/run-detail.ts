// The run page: summary, approval banner, jobs, commit, configuration, run logs and timeline.
// Every element shows data the hub stores or fetches (the commit's changed files
// come live from GitHub and the card is left out when they are not available).

import { CONFIG_JOB, SETUP_JOB } from "../checks/map";
import type { RunActions } from "../dashboard/run-actions";
import { runActionPath } from "../dashboard/run-actions";
import type { AnnotationRow } from "../db/annotations";
import type { InstallationRow } from "../db/installations";
import type { JobLogRow, RunListRow } from "../db/runs";
import type { CommitChanges } from "../github/types";
import { QUOTAS } from "../quotas";
import { S } from "../strings";
import { ulidTime } from "../ulid";
import {
	agoHtml,
	agoPlain,
	appPage,
	badge,
	branchLabel,
	type DashboardChrome,
	durationText,
	activeAttr,
	initOf,
	PAGE_SCRIPT,
	repoText,
	statusCircle,
	viewerOf,
} from "./dashboard";
import { escapeHtml } from "./layout";
import { icon } from "./shell";

const D = S.dashboard;
const T = D.detail;
const e = escapeHtml;

export interface RunDetailView {
	account: InstallationRow;
	login: string;
	chrome?: DashboardChrome;
	cookies?: string[];
	now: number;
	run: RunListRow;
	jobs: readonly JobLogRow[];
	/** The Approve, Cancel and Retry buttons that apply, and the csrf token their forms carry. */
	actions: RunActions;
	csrf: string;
	/** The text for the request's ?notice= value. */
	notice: string | null;
	/** The commit's changed files and date from GitHub; null when GitHub could not be asked. */
	changes: CommitChanges | null;
	/** The run's stored annotations, worst first. */
	annotations: readonly AnnotationRow[];
}

const ICONS: Record<string, string> = {
	copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6.5A2 2 0 0 0 13 4.5H6.5a2 2 0 0 0-2 2V13a2 2 0 0 0 2 2H9"/>',
	retry: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.4 3.8v4.6h-4.6"/>',
	stop: '<circle cx="12" cy="12" r="9"/><rect x="8.6" y="8.6" width="6.8" height="6.8" rx="1.4" fill="currentColor"/>',
	commit: '<circle cx="12" cy="12" r="3.6"/><path d="M2.5 12h5.9M15.6 12h5.9"/>',
	file: '<path d="M7 3.5h6.5l5 5V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5v5h5M9 13h6M9 16.5h4"/>',
	page: '<path d="M7 3.5h6.5l5 5V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5v5h5"/>',
	shieldx: '<path fill="currentColor" stroke="none" d="M12 1.4 1.6 5.4v6.6c0 5.8 4.2 10 10.4 11.4 6.2-1.4 10.4-5.6 10.4-11.4V5.4z"/><path stroke="#fff" stroke-width="2.4" d="M12 7.6v5.2M12 16.4v.1"/>',
	shieldb: '<path fill="currentColor" stroke="none" d="M12 2.2 3.4 5.6v6c0 5 3.6 8.6 8.6 10.2 5-1.6 8.6-5.2 8.6-10.2v-6z"/><path stroke="#2563eb" stroke-width="2.4" d="M12 8v4.6M12 16v.1"/>',
	"g-clock": '<path d="M12 7v5l3 2"/>',
	"al-failure": '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
	"al-warning": '<path d="M12 3.6 21.2 19.6H2.8z"/><path d="M12 10v4.4M12 17v.1"/>',
	"al-notice": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2M12 7.8v.1"/>',
};

const GATED_REASONS = ["fork_gated", "fork_never"];

const CSS = `
body.detail{background:#f8f9fa}
.main.detail{--ink:#03050e}
.detail .card{border-color:#f1f4f7;border-radius:8px;background:#fefefe}
.detail .bc{display:flex;align-items:center;gap:13px;height:20px;margin-bottom:18px;color:#667085;font-size:14px;letter-spacing:-.02em}
.detail .bc a{display:flex;align-items:center;gap:12px;color:inherit;text-decoration:none}
.detail .bc .ic{width:16px;height:16px}
.detail .bc a .ic{width:22px;height:22px;margin-left:-3px}
.detail .bc b{color:var(--ink);font-weight:500}
.detail .notice{margin-bottom:14px;padding:12px 18px;border:1px solid #cfe9db;border-radius:12px;background:#effaf4;color:#166534;font-size:14px}
.detail .sum{padding:22px 18px 17px 28px}
.detail .top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.detail .who{display:flex;align-items:center;gap:14.5px;min-height:34px;font-size:19px;font-weight:600}
.detail .who .gh{width:34px;height:34px;margin-left:-1px}
.detail .who .st{height:29px;padding:0 16px 0 10px;border-radius:10px;border-color:#fef5e6;background:#fef0d6;font-weight:500}
.detail .who .st .ic{width:19px;height:19px;color:#d97706}
.detail .who span:not(.st){position:relative;top:-1px;letter-spacing:-.005em}
.detail .acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:12px;margin-top:4px}
.detail .acts form{display:flex}
.detail .acts form[action$="/approve"]{margin-right:1px}
.detail .acts form[action$="/retry"] .bt{padding:0 14.5px}
.detail .acts form[action$="/cancel"] .bt{padding:0 13px}
.detail .bt{display:inline-flex;align-items:center;gap:9px;height:40px;padding:0 15px;border:1px solid #e8ebf3;border-radius:6px;background:#fefefe;color:var(--ink);font:inherit;font-size:13px;font-weight:500;letter-spacing:-.025em;text-decoration:none;white-space:nowrap;cursor:pointer}
.detail .bt .ic{width:20px;height:20px}
.detail .bt.pr{border-color:#136af7;background:#136af7;color:#fff}
.detail .bt.pr:hover{background:#1d4ed8}
.detail .bt:hover{background:#fafbfc}
.detail .bt.off{color:#a3a9bb;background:#f8f9fb;cursor:default}
.detail h1.tt{margin-top:-1px;font-size:30px;line-height:34px;font-weight:700;letter-spacing:-.068em}
.detail .meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 0;margin-top:10px;color:#475475;font-size:13px;letter-spacing:-.02em}
.detail .meta>*+*{margin-left:19px;padding-left:19px;border-left:1px solid #dfe2ea}
.detail .meta .ref{padding:3px 14px 3px 13px;border:0;border-radius:7px;background:#eef2ff;color:#4338ca;font-weight:500;letter-spacing:0}
.detail .meta>.ref+*{margin-left:25px;padding-left:0;border-left:0}
.detail .meta>.shaw+.person{margin-left:14px;padding-left:15px}
.detail .mono,.detail code,.detail .csha{font-family:SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.detail .mono{font-size:13px;letter-spacing:0}
.detail .shaw{display:inline-flex;align-items:center;gap:9px}
.detail .cp{display:inline-grid;place-items:center;width:22px;height:22px;padding:0;border:0;background:none;color:#6a7490;cursor:pointer}
.detail .cp:hover{color:var(--ink)}
.detail .cp[data-done]{color:#15803d}
.detail .cp .ic{width:20px;height:20px}
.detail .person{display:inline-flex;align-items:center;gap:8px}
.detail .av{position:relative;display:inline-grid;place-items:center;flex:none;width:22px;height:22px;overflow:hidden;border-radius:50%;background:#e5e7eb;color:#4b5563;font-size:11px;font-weight:600}
.detail .av img{position:absolute;inset:0;width:100%;height:100%}
.detail .made{position:relative;top:-1px;margin-top:7px;color:#78829b;font-size:14.5px}
.detail .warn{display:flex;gap:30px;margin:13px 0 16px;padding:15px 28px 12px 26px;border:1px solid #feeedc;border-radius:8px;background:#fef7f0;color:#a8482f}
.detail .warn .ic{width:34px;height:34px;margin:0 -2px 0 -2px;color:#f97316}
.detail .warn b{display:block;color:#b42b01;font-size:16px;line-height:22px;font-weight:600;letter-spacing:-.03em}
.detail .warn p{font-size:14px;line-height:20px;letter-spacing:-.01em}
.detail .warn code{font-size:14px;letter-spacing:0}
.detail .cols{display:grid;grid-template-columns:562fr 578fr;gap:14px;align-items:start}
.detail .col>*+*{margin-top:15px}
.detail .ch{padding:1px 20px 0 21px;height:58px}
.detail .ch h2{font-size:21px;font-weight:600;letter-spacing:-.05em}
.detail .ch .cnt2{letter-spacing:-.035em}
.detail .jlist details{margin:0 17px 0 20px;border-top:1px solid var(--line-2)}
.detail .jlist details:first-child{border-top:0}
.detail .jlist{padding-bottom:3px}
.detail .jr2{display:flex;align-items:center;gap:14px;padding:10px 5px 11px 6px;list-style:none;cursor:pointer}
.detail .jr2::-webkit-details-marker{display:none}
.detail .jr2 .tx{flex:1;min-width:0;margin:3px 0 0 10px}
.detail .jr2 .nm{display:flex;align-items:center;gap:0;margin-top:-1px}
.detail .jr2 .nm b{flex:none;margin-right:23px;font-size:16px;font-weight:600;overflow-wrap:anywhere}
.detail .jr2 .nm .st.wait{margin-left:5px}
.detail .jr2 .d{display:block;margin-top:4px;color:#6a7490;font-size:13px;letter-spacing:-.01em}
.detail .jr2 .d .sep{margin:0 7px;font-style:normal}
.detail .jr2 .st{position:relative;top:-1px;height:25px;padding:0 10px;border-radius:10px;background:#eef0f4;font-size:12px;letter-spacing:-.02em;font-weight:500}
.detail .jr2 .st.wait{background:#fef0d6}
.detail .jr2 .st .ic{display:none}
.detail .jr2 .du{display:grid;place-items:center;width:126px;color:#6a7490;font-size:14px}
.detail .dash{display:block;width:12px;height:1px;background:#9aa1b4}
.detail .tm .dash{width:14px}
.detail .jr2 .bt{height:33px;margin-right:4px;padding:0 14px;border-radius:8px}
.detail .jr2 .sc.wait{background:#fde6b4;color:#d36d0a}
.detail .jr2 .sc{width:30px;height:30px;margin:0 -1px}
.detail .jr2 .sc .ic{width:28px;height:28px;stroke-width:3}
.detail .jr2 .cv{width:20px;height:20px;color:#6a7490}
.detail details[open] .cv{transform:rotate(180deg)}
.detail .ring{display:inline-block;flex:none;width:28px;height:28px;border:2px solid #7d839a;border-radius:50%;background:#fff}
.detail .tm .sc{width:28px;height:28px}
.detail .jmore{padding:0 5px 16px 44px;color:#6a7490;font-size:13.5px}
.detail .empty{padding:24px 22px}
.detail .cmc{padding-bottom:18px}
.detail .cmh{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 12px 0 21px}
.detail .cmh h2{margin-top:-2px;font-size:20px;font-weight:600;letter-spacing:-.065em;line-height:24px}
.detail .cmh .bt{height:38px;padding:0 15px 0 13.5px;font-size:13px;letter-spacing:-.03em}
.detail .cmc .cmh .bt .ic{width:14px;height:14px}
.detail .cfc{position:relative;padding-bottom:19px}
.detail .cfc .cmh{padding-top:15px}
.detail .cfc .cmh h2{font-size:18px;font-weight:700;letter-spacing:-.045em}
.detail .cfc .cmh .bt{position:absolute;top:21px;right:18px;gap:7px;height:36px;padding:0 13px 0 22px;font-size:12.75px;letter-spacing:-.047em}
.detail .cfv{display:flex;align-items:center;gap:12px;margin:15px 21px 0 20px;font-size:15.5px;font-weight:500;letter-spacing:-.05em}
.detail .cfv.ok{color:#15803d}
.detail .cfv.bad{color:#b91c1c}
.detail .cfv .sc{width:27px;height:27px}
.detail .cfv .sc .ic{width:18px;height:18px;stroke-width:3}
.detail .cfd{margin:10px 21px 0;color:#6a7490;font-size:14px;letter-spacing:-.02em}
.detail .cfd .sep{margin:0 6px;font-style:normal}
.detail .cm{display:flex;align-items:center;gap:12px;padding:0 21px 0 20px}
.detail .cm .ic{width:24px;height:24px;color:#4b5563}
.detail .csha{color:#2563eb;font-size:15px}
.detail .ctitle{margin-top:2px;padding:0 22px 0 56px;font-size:16.5px;line-height:24px;font-weight:600;letter-spacing:-.055em}
.detail .cby{display:flex;align-items:center;padding:0 22px 0 56px;color:#6a7490;font-size:13px;letter-spacing:-.04em}
.detail .cby .av{width:24px;height:24px}
.detail .cby .sep{margin:0 9px 0 7px;font-style:normal}
.detail .fh{display:flex;align-items:center;gap:14px;height:28px;margin:23.5px 0 5.5px;padding:0 21px;font-size:17px;font-weight:600;letter-spacing:-.05em}
.detail .cnt{display:inline-grid;place-items:center;min-width:27px;height:27px;padding:0 6px;border-radius:14px;background:#eef0f4;font-size:13px;font-weight:600;letter-spacing:0}
.detail .fr{display:flex;align-items:center;gap:12px;padding:10px 22px;border-top:1px solid var(--line-2);font-size:14.5px}
.detail .fr .ic{width:18px;height:18px;color:#6a7490}
.detail .fr .fn{flex:1;min-width:0;overflow-wrap:anywhere}
.detail .ff{height:34px;margin:0 21px 0 22px;padding:0 13px 0 11px;font-size:13px;letter-spacing:-.01em}
.detail .ff .ic{width:25px;height:25px;margin:0 2px 0 -5px}
.detail .ff .fn{flex:0 0 277px}
.detail .bar{display:flex;flex:none;overflow:hidden;height:6px;border-radius:3px;background:#e5e7eb}
.detail .bar.s1{width:10px}
.detail .bar.s2{width:30px}
.detail .bar.s3{width:44px}
.detail .bar i{flex:1;background:#e5e7eb}
.detail .bar i.a{background:#22a864}
.detail .bar i.r{background:#e5484d}
.detail .add{margin-left:auto;color:#15803d;font-weight:600}
.detail .add+.del{margin-left:-2px}
.detail .del{color:#dc2626;font-weight:600}
.detail .fm{padding:10px 22px 14px;color:#6a7490;font-size:13.5px}
.detail .rl{display:flex;gap:20px;align-items:center;min-height:159px;margin:3px 21px 27px 22px;padding:0 28px;border-radius:12px;background:#f7f8fa}
.detail .rl .bg2{display:grid;place-items:center;flex:none;width:62px;height:62px;border-radius:50%;background:#eef0f4;color:#475467}
.detail .rl .bg2 .ic{width:30px;height:30px}
.detail .rl b{display:block;font-size:15px;font-weight:600}
.detail .rl span.s{display:block;margin-top:2px;color:#6a7490;font-size:14px}
.detail .tmw{margin-top:13px}
.detail .tmw .ch,.detail .rlc .ch{border-bottom:0}
.detail .tmw .ch h2{margin-top:-2px}
.detail .tm{margin:-11px 0 0;padding:0 27px 23px;list-style:none}
.detail .tm li{position:relative;display:grid;grid-template-columns:28px 230px 154px 1fr;align-items:center;column-gap:28px;min-height:52px}
.detail .tm li+li:before{content:"";position:absolute;left:13px;top:-13px;height:14px;border-left:2px solid #dfe2ea}
.detail .tm b{font-weight:500;font-size:14.5px;letter-spacing:-.03em}
.detail .tm li.cur b{font-weight:600}
.detail .tm .t,.detail .tm .x{color:#667085;font-size:13px;letter-spacing:-.01em}
.detail .tm .sc .ic{width:18px;height:18px;stroke-width:3}
.detail .tm .sc.wait{background:#e5720f;color:#fff}
.detail .tm .sc.wait .ic{width:22px;height:22px;stroke-width:2.4}
.detail .cfc .anc{margin:21px 20px 0;padding-top:0;border-top:1px solid #e6e9f0}
.detail .cfo .anc{margin-top:0;border-top:0}
.detail .anh{position:relative;display:flex;align-items:center;gap:14px;height:68px;padding-top:2px;font-size:17px}
.detail .anh h2{font-size:18px;font-weight:700;letter-spacing:-.05em}
.detail .flt{position:absolute;right:-1px;top:15px}
.detail .flt summary{height:36px;padding:0 12px 0 15px;gap:8px;list-style:none;font-size:13.75px;letter-spacing:-.03em}
.detail .flt summary::-webkit-details-marker{display:none}
.detail .flt .cv{width:16px;height:16px;color:#6a7490}
.detail .fmenu{position:absolute;right:0;top:40px;z-index:2;display:grid;gap:2px;min-width:150px;padding:6px;border:1px solid #dfe2ea;border-radius:9px;background:#fff;box-shadow:0 6px 18px rgba(16,24,40,.1);font-size:13.5px}
.detail .fmenu label{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:6px;cursor:pointer}
.detail .fmenu label:hover{background:#f4f5f8}
.detail .anc .rl{gap:20px;margin:0;min-height:116px;padding:0 27px}
.detail .anc .rl .bg2{width:60px;height:60px}
.detail .anl{margin:0;padding:0 0 4px;list-style:none}
.detail .an{display:flex;gap:12px;padding:12px 4px;border-top:1px solid var(--line-2)}
.detail .an:first-child{border-top:0}
.detail .anm{display:grid;place-items:center;flex:none;width:22px;height:22px}
.detail .anm .ic{width:20px;height:20px}
.detail .an.lv-failure .anm{color:#dc2626}
.detail .an.lv-warning .anm{color:#d97706}
.detail .an.lv-notice .anm{color:#2563eb}
.detail .ab{min-width:0;flex:1;font-size:13.5px;line-height:20px}
.detail .ab b{display:block;font-size:14.5px;font-weight:600}
.detail .ab p{overflow-wrap:anywhere;white-space:pre-wrap}
.detail .al{display:block;margin-top:2px;color:#6a7490;font-size:12.5px;overflow-wrap:anywhere}
.detail .al a{color:#2563eb;text-decoration:none}
.detail .al a:hover{text-decoration:underline}
.detail .al .sep{margin:0 7px;font-style:normal}
.detail .anc:has(.fmenu input[value=failure]:not(:checked)) .an.lv-failure,.detail .anc:has(.fmenu input[value=warning]:not(:checked)) .an.lv-warning,.detail .anc:has(.fmenu input[value=notice]:not(:checked)) .an.lv-notice{display:none}
@media (max-width:900px){
.detail .who{flex-wrap:wrap}
.detail .cols{grid-template-columns:1fr}
.detail .top{flex-direction:column}
.detail .acts{justify-content:flex-start}
.detail .tm li{grid-template-columns:28px 1fr;row-gap:2px}
.detail .tm .t,.detail .tm .x{grid-column:2}
.detail .jr2{flex-wrap:wrap;padding-left:0}
.detail .jr2 .tx{flex:1 1 140px}
.detail .jr2 .nm{flex-wrap:wrap;gap:6px 14px}
.detail .jr2 .du{width:auto;margin-left:44px;margin-right:auto}
.detail .ff .fn{flex:1}
.detail .cfc .cmh .bt{position:static;flex:none}
}
@media (min-width:901px){
.detail .av{font-size:12px}
}
@media (max-width:900px){
.detail .av{font-size:12px}
.detail .bc{height:auto;min-height:44px;margin-bottom:8px}
.detail .bc a{min-width:44px;min-height:44px}
.detail .sum{padding:18px 16px 16px}
.detail .top{gap:12px;min-width:0}
.detail .who{min-width:0;overflow-wrap:anywhere}
.detail .acts{gap:12px;margin:8px 0 16px}
.detail .bt,.detail .jr2 .bt,.detail .cmh .bt,.detail .cfc .cmh .bt{min-height:44px;height:44px}
.detail .cp{position:relative}
.detail .cp::after{content:"";position:absolute;top:-11px;left:-11px;width:44px;height:44px}
.detail h1.tt{font-size:26px;line-height:32px;overflow-wrap:anywhere}
.detail .meta{gap:8px 12px;min-width:0}
.detail .meta>*+*,.detail .meta>.ref+*,.detail .meta>.shaw+.person{margin-left:0;padding-left:0;border-left:0}
.detail .meta>*{min-width:0;max-width:100%;overflow-wrap:anywhere}
.detail .warn{gap:16px;padding:14px 16px}
.detail .cols{grid-template-columns:minmax(0,1fr)}
.detail .col{min-width:0}
.detail .jr2{margin:4px 0}
.detail .meta{margin-top:24px}
.detail .al a{display:inline-flex;align-items:center;min-height:44px}
.detail .ch{height:auto;min-height:58px;padding:8px 16px}
.detail .cmh{flex-wrap:wrap;padding:16px 16px 0}
.detail .cfc .cmh{padding-top:15px}
.detail .cfv{flex-wrap:wrap;margin:15px 16px 0}
.detail .cfd{margin:10px 16px 0;overflow-wrap:anywhere}
.detail .cm{flex-wrap:wrap;padding:20px 16px 0}
.detail .csha{overflow-wrap:anywhere}
.detail .ctitle,.detail .cby{padding:0 16px 0 52px;overflow-wrap:anywhere}
.detail .cby{flex-wrap:wrap;gap:4px 0}
.detail .fh{padding:0 16px}
.detail .fr{padding:10px 16px}
.detail .ff{margin:0 16px}
.detail .fm{padding:10px 16px 14px}
.detail .jlist details{margin:0 12px}
.detail .jmore{padding-left:12px}
.detail .rl,.detail .anc .rl{flex-wrap:wrap;gap:16px;margin:3px 16px 20px;padding:20px 16px}
.detail .anc .rl{margin:0}
.detail .tm{padding:0 16px 23px}
.detail .tm li{column-gap:16px}
.detail .tm .t,.detail .tm .x{overflow-wrap:anywhere}
.detail .cfc .anc{margin:21px 16px 0}
.detail .flt summary{height:44px}
.detail .flt:not([open]) .fmenu{display:none}
.detail .fmenu{gap:8px;max-width:calc(100vw - 32px)}
.detail .fmenu label{min-height:44px}
}
@media (max-width:640px){
.detail .acts{flex-direction:column;align-items:stretch;align-self:stretch;width:100%}
.detail .acts form,.detail .acts .bt{width:100%}
.detail .acts .bt{justify-content:center}
.detail .cfc .cmh .bt,.detail .cmh .bt{width:100%;justify-content:center}
}
`;

function avatar(login: string | null): string {
	if (login === null) return "";
	const url = `https://github.com/${encodeURIComponent(login)}.png?size=44`;
	return `<span class="av">${e(login.slice(0, 1).toUpperCase())}<img src="${e(url)}" alt="" width="22" height="22" loading="lazy" referrerpolicy="no-referrer"></span>`;
}

function person(login: string | null): string {
	return login === null ? "" : `<span class="person">${avatar(login)}${e(login)}</span>`;
}

function copyButton(text: string): string {
	return `<button type="button" class="cp" data-copy="${e(text)}" aria-label="${e(T.copySha)}" hidden>${icon("copy")}</button>`;
}

function actionForm(v: RunDetailView, action: "approve" | "cancel" | "retry", label: string, glyph: string, cls: string): string {
	if (!v.actions[action]) return "";
	const path = runActionPath(v.account.id, v.run.run_id, action);
	return `<form method="post" action="${e(path)}"><input type="hidden" name="csrf" value="${e(v.csrf)}"><button type="submit" class="bt${cls}">${icon(glyph)}${e(label)}</button></form>`;
}

function githubLink(href: string | null): string {
	return href === null ? "" : `<a class="bt" href="${e(href)}" rel="noopener noreferrer">${icon("out")}${e(T.openInGithub)}</a>`;
}

function metaRow(v: RunDetailView): string {
	const { run } = v;
	const sha = run.sha.slice(0, 7);
	const pr = run.pr_number === null ? `<span class="ref">${e(branchLabel(run.ref))}</span>` : `<span class="ref">${e(D.pullRequest(run.pr_number))}</span>`;
	const parts = [
		pr,
		`<span class="shaw"><span class="mono">${e(sha)}</span>${copyButton(run.sha)}</span>`,
		person(run.author_login),
		`<span>${e(run.event)}</span>`,
		`<span>${e(T.attempt(run.attempt))}</span>`,
		run.agent_name === null ? "" : `<span>${e(T.agent(run.agent_name))}</span>`,
	];
	return `<div class="meta">${parts.join("")}</div>`;
}

/** The state pill; a gated run reads as waiting, with the clock the approval flow uses. */
function runBadge(state: string): string {
	return state === "gated" ? `<span class="st wait">${icon("clock")}${e(D.state[state] ?? state)}</span>` : badge(state);
}

/** When the hub recorded the run: run.created_at, or the time inside the trigger id for a run stored before created_at existed. */
function createdAt(run: RunListRow): number | null {
	return run.created_at > 0 ? run.created_at : ulidTime(run.trigger_id);
}

function dash() {
	return `<i class="dash" role="img" aria-label="${e(D.none)}"></i>`;
}

function summaryCard(v: RunDetailView, commitUrl: string | null): string {
	const { run } = v;
	const forms =
		actionForm(v, "approve", T.approve, "shieldb", " pr") + actionForm(v, "cancel", T.cancel, "stop", "") + actionForm(v, "retry", T.retry, "retry", "");
	const title = run.commit_title ?? D.runTitle(repoText(run));
	const created = createdAt(run);
	const mins = created === null ? 0 : Math.floor((v.now - created) / 60_000);
	const label = created === null ? "" : mins >= 1 && mins < 60 ? T.createdMinutes(mins) : T.createdAgo(agoPlain(created, v.now));
	const started = created === null ? "" : `<p class="made">${e(label)}</p>`;
	const reason =
		run.reason === null || GATED_REASONS.includes(run.reason) ? "" : `<p class="made">${e(T.reasonLabel)}: ${e(run.reason)}</p>`;
	return (
		`<section class="card sum"><div class="top"><div class="who">${icon("github", "gh")}<span>${e(repoText(run))}</span>${runBadge(run.state)}</div>` +
		`<div class="acts">${forms}${githubLink(commitUrl)}</div></div>` +
		`<h1 class="tt">${e(title)}</h1>${metaRow(v)}${started}${reason}</section>`
	);
}

function banner(run: RunListRow): string {
	if (run.state !== "gated") return "";
	if (run.reason === "fork_never") return `<div class="warn">${icon("shieldx")}<div><b>${e(T.neverTitle)}</b><p>${e(T.neverBody)}</p></div></div>`;
	return (
		`<div class="warn">${icon("shieldx")}<div><b>${e(T.gatedTitle)}</b><p>${e(T.gatedBody)}<br>` +
		`${e(T.gatedApplyBefore)}<code>${e(run.sha.slice(0, 7))}</code>${e(T.gatedApplyAfter)}</p></div></div>`
	);
}

const WAITING: Record<string, true> = { received: true, pending: true, queued: true };
const DONE: Record<string, true> = { success: true, failed: true, cancelled: true, skipped: true, interrupted: true };
const NOT_STARTED: Record<string, true> = { ...WAITING, gated: true };

function jobMark(state: string): string {
	return WAITING[state] === true ? `<span class="ring" title="${e(D.state[state] ?? state)}"></span>` : statusCircle(state);
}

function logHref(base: string, runId: string, job: string): string {
	return `${base}/runs/${encodeURIComponent(runId)}/logs/${encodeURIComponent(job)}/view`;
}

function jobRow(job: JobLogRow, base: string, runId: string, now: number): string {
	// step_index counts from 0; an index past the total came from an older agent that numbered sub-steps, so it says nothing about position.
	const position = job.step_index === null ? 1 : job.step_index + 1;
	const stepLine = job.steps_total === null || position > job.steps_total ? null : T.step(position, job.steps_total);
	const stepName = job.step !== null && job.step !== "" ? job.step : NOT_STARTED[job.state] === true ? T.notStarted : null;
	const running = NOT_STARTED[job.state] !== true && DONE[job.state] !== true;
	const stepFor =
		running && job.step !== null && job.step !== "" && job.step_started_at != null && job.step_started_at <= now
			? T.stepFor(durationText(now - job.step_started_at))
			: null;
	const detail = [stepLine, stepName, stepFor].filter((x): x is string => x !== null);
	const href = logHref(base, runId, job.name);
	const log =
		job.log_key === null
			? `<span class="bt off" title="${e(D.noLogYet)}">${e(T.viewLog)}</span>`
			: `<a class="bt" href="${e(href)}">${e(T.viewLog)}</a>`;
	const more = [
		D.state[job.state] ?? job.state,
		job.log_key !== null && job.log_bytes !== null ? `${job.log_bytes} bytes` : D.noLogYet,
		job.log_key !== null && job.log_truncated === 1 ? D.logTruncated(QUOTAS.logBytes / 1_048_576) : null,
	].filter((x): x is string => x !== null);
	return (
		`<details><summary class="jr2">${jobMark(job.state)}<div class="tx"><div class="nm"><b>${e(job.name)}</b>${badge(job.state)}</div>` +
		`${detail.length === 0 ? "" : `<span class="d">${detail.map(e).join('<i class="sep">\u00b7</i>')}</span>`}</div>` +
		`<span class="du">${job.duration_ms === null ? dash() : e(durationText(job.duration_ms))}</span>${log}${icon("chevd", "cv")}</summary><p class="jmore">${e(more.join(" \u00b7 "))}</p></details>`
	);
}

/** The run's jobs without the agent's configuration check, which has its own card. */
function workJobs(v: RunDetailView): JobLogRow[] {
	return v.jobs.filter((j) => j.name !== CONFIG_JOB);
}

/** The agent's latest setup stage while the run's jobs have not started, so a long setup does not look stuck. Empty otherwise, and when the run has a setup job: that row shows the stage itself. */
function setupBanner(v: RunDetailView, jobs: JobLogRow[]): string {
	const { run } = v;
	if (run.state !== "running" || run.setup_step === null || jobs.some((j) => j.name === SETUP_JOB || NOT_STARTED[j.state] !== true)) return "";
	return `<p class="muted setup-stage">${e(T.setupStage(run.setup_step, run.setup_step_index ?? 0, run.setup_steps_total))}</p>`;
}

function jobsCard(v: RunDetailView): string {
	const base = `/${v.account.id}`;
	const jobs = workJobs(v);
	const done = jobs.filter((j) => DONE[j.state] === true).length;
	const list = jobs.length === 0 ? `<p class="empty muted">${e(D.noJobs)}</p>` : `<div class="jlist">${jobs.map((j) => jobRow(j, base, v.run.run_id, v.now)).join("")}</div>`;
	return `<section class="card"><div class="ch"><h2>${e(T.jobs)}</h2><span class="cnt2">${e(T.jobsCount(done, jobs.length))}</span></div>${setupBanner(v, jobs)}${list}</section>`;
}

const BAR_CELLS = 5;

function changeBar(add: number, del: number): string {
	const total = add + del;
	const adds = total === 0 ? 0 : Math.round((add / total) * BAR_CELLS);
	const dels = total === 0 ? 0 : BAR_CELLS - adds;
	const size = total < 16 ? "s1" : total < 60 ? "s2" : "s3";
	return `<span class="bar ${size}" aria-hidden="true">${"<i class=\"a\"></i>".repeat(adds)}${"<i class=\"r\"></i>".repeat(dels)}${"<i></i>".repeat(BAR_CELLS - adds - dels)}</span>`;
}

const FILES_SHOWN = 12;

function filesBlock(changes: CommitChanges | null): string {
	if (changes === null || changes.files.length === 0) return "";
	const rows = changes.files
		.slice(0, FILES_SHOWN)
		.map(
			(f) =>
				`<div class="fr ff">${icon("page")}<span class="fn">${e(f.filename)}</span>${changeBar(f.additions, f.deletions)}<span class="add">+${f.additions}</span><span class="del">\u2212${f.deletions}</span></div>`,
		)
		.join("");
	const more = changes.files.length > FILES_SHOWN ? `<p class="fm">${e(T.moreFiles(changes.files.length - FILES_SHOWN))}</p>` : "";
	return `<div class="fh">${e(T.changedFiles)}<span class="cnt">${changes.files.length}</span></div>${rows}${more}`;
}

function commitCard(v: RunDetailView, commitUrl: string | null): string {
	const { run } = v;
	const title = run.commit_title === null ? "" : `<div class="ctitle">${e(run.commit_title)}</div>`;
	const when = v.changes?.committedAt == null ? "" : `<i class="sep">\u00b7</i><span>${agoHtml(v.changes.committedAt, v.now)}</span>`;
	const by = run.author_login === null && when === "" ? "" : `<div class="cby">${person(run.author_login)}${when}</div>`;
	return (
		`<section class="card cmc"><div class="cmh"><h2>${e(T.commit)}</h2>${githubLink(commitUrl)}</div>` +
		`<div class="cm">${icon("commit")}<span class="csha">${e(run.sha.slice(0, 7))}</span>${copyButton(run.sha)}</div>${title}${by}${filesBlock(v.changes)}</section>`
	);
}

/**
 * What the agent reported about .hookci.yml: it checks the file under the _config job when a pull request changes it
 * and rejects a run whose file is invalid. Null when the hub has heard neither, since a run without a verdict says nothing about the file.
 */
function configVerdict(v: RunDetailView): boolean | null {
	const state = v.jobs.find((j) => j.name === CONFIG_JOB)?.state;
	if (state === "failed" || v.run.reason === "config_invalid") return false;
	return state === "success" ? true : null;
}

function configBlock(v: RunDetailView): string {
	const valid = configVerdict(v);
	if (valid === null) return "";
	const { run } = v;
	const open =
		run.repo_name === null ? "" : `<a class="bt" href="${e(T.configUrl(run.repo_name, run.sha))}" rel="noopener noreferrer">${e(T.viewConfiguration)}${icon("out")}</a>`;
	const detail = valid ? `<p class="cfd">${e(T.configJobs(workJobs(v).filter((j) => j.name !== SETUP_JOB).length))}<i class="sep">\u00b7</i>${e(T.configValidated)}</p>` : "";
	return (
		`<div class="cmh"><h2>${e(T.configuration)}</h2>${open}</div>` +
		`<p class="cfv ${valid ? "ok" : "bad"}">${valid ? tmMark("ok") : statusCircle("failed")}${e(valid ? S.checks.configValid : S.checks.configInvalid)}</p>${detail}`
	);
}

function annotationLocation(a: AnnotationRow, run: RunListRow): string {
	const where = `${e(a.path)}:${a.start_line}`;
	if (run.repo_name === null) return where;
	return `<a href="${e(T.annotationUrl(run.repo_name, run.sha, a.path, a.start_line))}" rel="noopener noreferrer">${where}</a>`;
}

function annotationItem(a: AnnotationRow, run: RunListRow): string {
	const level = e(T.levelOne[a.level] ?? a.level);
	const head = a.title === null || a.title === "" ? "" : `<b>${e(a.title)}</b>`;
	return (
		`<li class="an lv-${a.level}"><span class="anm" title="${level}">${icon(`al-${a.level}`)}<span class="sr">${level}</span></span>` +
		`<div class="ab">${head}<p>${e(a.message)}</p><span class="al">${annotationLocation(a, run)}<i class="sep">\u00b7</i>${e(a.job)}</span></div></li>`
	);
}

function filterMenu(): string {
	const boxes = Object.keys(T.levels)
		.map((l) => `<label><input type="checkbox" value="${l}" checked>${e(T.levels[l] ?? l)}</label>`)
		.join("");
	return `<details class="flt"><summary class="bt">${e(T.filter)}${icon("chevd", "cv")}</summary><div class="fmenu">${boxes}</div></details>`;
}

function annotationsBlock(v: RunDetailView): string {
	const list = v.annotations;
	const body =
		list.length === 0
			? `<div class="rl"><span class="bg2">${icon("file")}</span><div><b>${e(T.annotationsEmptyTitle)}</b><span class="s">${e(T.annotationsEmptyBody)}</span></div></div>`
			: `<ul class="anl">${list.map((a) => annotationItem(a, v.run)).join("")}</ul>`;
	return `<div class="anc"><div class="anh"><h2>${e(T.annotations)}</h2><span class="cnt">${list.length}</span>${filterMenu()}</div>${body}</div>`;
}

/** The right column's top card: the configuration verdict (when the agent reported one) above the run's annotations. */
function configCard(v: RunDetailView): string {
	const config = configBlock(v);
	return `<section class="card cfc${config === "" ? " cfo" : ""}">${config}${annotationsBlock(v)}</section>`;
}

function logsCard(v: RunDetailView): string {
	const base = `/${v.account.id}`;
	const withLog = workJobs(v).filter((j) => j.log_key !== null);
	const head = `<div class="ch"><h2>${e(T.runLogs)}</h2></div>`;
	if (withLog.length === 0) {
		return `<section class="card rlc">${head}<div class="rl"><span class="bg2">${icon("file")}</span><div><b>${e(T.noLogsTitle)}</b><span class="s">${e(T.noLogsBody)}</span></div></div></section>`;
	}
	const rows = withLog
		.map((j) => {
			const href = logHref(base, v.run.run_id, j.name);
			return `<div class="fr">${icon("file")}<span class="fn">${e(j.name)}</span><a class="bt" href="${e(href)}">${e(T.viewLog)}</a></div>`;
		})
		.join("");
	return `<section class="card">${head}${rows}</section>`;
}

type Mark = "ok" | "wait" | "ring" | "busy";

function tmMark(mark: Mark, state?: string): string {
	if (mark === "ring") return '<span class="ring"></span>';
	if (state !== undefined) return statusCircle(state);
	if (mark === "wait") return `<span class="sc wait">${icon("g-clock")}</span>`;
	return `<span class="sc ${mark}">${icon(mark === "ok" ? "g-tick" : "g-play")}</span>`;
}

interface Step {
	mark: string;
	title: string;
	at: number | null;
	body: string;
	cur?: boolean;
}

function steps(v: RunDetailView): Step[] {
	const { run } = v;
	const source = run.pr_number === null ? branchLabel(run.ref) : T.pullRequest(run.pr_number);
	const created = createdAt(run);
	const out: Step[] = [{ mark: tmMark("ok"), title: T.created, at: created, body: T.createdBody(source, run.sha.slice(0, 7), run.author_login) }];
	if (run.state === "gated") {
		out.push({ mark: tmMark("wait"), title: T.waiting, at: created, body: T.waitingBody, cur: true });
		out.push({ mark: tmMark("ring"), title: T.jobsNotStarted, at: null, body: T.jobsNotStartedBody });
		return out;
	}
	if (run.started_at !== null) out.push({ mark: tmMark(run.finished_at === null ? "busy" : "ok"), title: T.running, at: run.started_at, body: T.runningBody });
	if (run.finished_at !== null) {
		out.push({ mark: tmMark("ok", run.state), title: T.finished, at: run.finished_at, body: T.finishedBody(D.state[run.state] ?? run.state), cur: true });
	}
	return out;
}

function timeline(v: RunDetailView): string {
	const items = steps(v).map(
		(s) =>
			`<li${s.cur ? ' class="cur"' : ""}>${s.mark}<b>${e(s.title)}</b><span class="t">${s.at === null ? dash() : agoHtml(s.at, v.now)}</span><span class="x">${e(s.body)}</span></li>`,
	);
	return `<section class="card"><div class="ch"><h2>${e(T.timeline)}</h2></div><ol class="tm">${items.join("")}</ol></section>`;
}

/** A finished run keeps polling for late annotations and log links for this long, then stops. */
const IDLE_POLL_MS = 300_000;

function swap(name: string, v: RunDetailView, html: string): string {
	const recent = v.run.finished_at !== null && v.now - v.run.finished_at < IDLE_POLL_MS;
	return `<div data-swap="${name}"${recent ? ' data-idle="10000"' : ""}${activeAttr([v.run.state])}>${html}</div>`;
}

export function runPage(v: RunDetailView): Promise<Response> {
	const { run } = v;
	const base = `/${v.account.id}`;
	const commitUrl = run.repo_name === null ? null : D.githubCommitUrl(run.repo_name, run.sha);
	const main =
		`<div class="bc"><a href="${base}/runs">${icon("back")}${e(T.breadcrumb)}</a>${icon("chev")}<b>${e(T.run(String(run.run_number)))}</b></div>` +
		`${v.notice === null ? "" : `<p class="notice" role="status">${e(v.notice)}</p>`}${swap("summary", v, summaryCard(v, commitUrl) + banner(run))}` +
		`<div class="cols"><div class="col">${swap("jobs", v, jobsCard(v))}${swap("commit", v, commitCard(v, commitUrl))}</div><div class="col">${swap("config", v, configCard(v))}${swap("logs", v, logsCard(v))}</div></div>` +
		`<div class="tmw">${swap("timeline", v, timeline(v))}</div>`;
	return appPage({
		title: D.runTitle(repoText(run)),
		bodyClass: "detail",
		main,
		viewer: viewerOf(v, "runs"),
		init: initOf(v),
		css: CSS,
		icons: ICONS,
		script: PAGE_SCRIPT,
		avatars: true,
		forms: v.chrome !== undefined || v.actions.approve || v.actions.cancel || v.actions.retry,
	});
}
