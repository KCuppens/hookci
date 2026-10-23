// One agent's page: summary and facts, its repository bindings, the runs it executed and the
// commands that maintain it. Revoke and unbind are session POSTs (routes/agent-detail.ts).

import type { AgentBindingRow } from "../db/agent-detail";
import type { AgentRow } from "../db/agents";
import type { InstallationRow } from "../db/installations";
import type { RunListRow } from "../db/runs";
import { bindPath } from "../dashboard/repositories";
import { upgradeHint } from "../slack/home";
import { S } from "../strings";
import { CAPACITY_CSS, capacityCard } from "./agent-capacity";
import { TRACED_ICONS } from "./agent-detail-icons";
import { AGENT_ICONS, AGENT_UI_CSS, copyBox, platformLines, statusChip } from "./agent-ui";
import { agoHtml, appPage, type DashboardChrome, dateOf, initOf, PAGE_SCRIPT, rowMenu, runHref, shortRepo, viewerOf } from "./dashboard";
import { escapeHtml } from "./layout";
import { PILL_CSS, PILL_ICONS, runPill } from "./pills";
import { durationCell, ENV_CLASS, nil, refCell, RUN_ICONS, shaCell } from "./runs";
import { icon } from "./shell";

const A = S.agents;
const D = A.detail;
const e = escapeHtml;
const MINUTES_AGO = S.dashboard.ago.minutesLong;

export interface AgentDetailView {
	account: InstallationRow;
	accounts: readonly InstallationRow[];
	login: string;
	chrome?: DashboardChrome;
	cookies?: string[];
	/** The csrf token of the revoke and unbind forms. */
	csrf: string;
	now: number;
	latestAgentVersion: string;
	agent: AgentRow;
	bindings: readonly AgentBindingRow[];
	runs: readonly RunListRow[];
	/** The GitHub login of whoever paired the agent, when known. */
	pairedBy: string | null;
	/** The text for the request's ?notice= value. */
	notice: string | null;
}

const ICONS: Record<string, string> = {
	trash: '<path stroke-width="1.6" d="M4.5 6.95H19.5M7.7 6.95V4.25Q7.7 3.25 8.7 3.25H14.7Q15.7 3.25 15.7 4.25V6.95M6.5 6.95V19.75Q6.5 20.75 7.5 20.75H15.9Q16.9 20.75 16.9 19.75V6.95"/>',
	out: '<path stroke-width="1.7" d="M13.25 4.85H7.9Q4.9 4.85 4.9 7.85V16.15Q4.9 19.15 7.9 19.15H16.1Q19.1 19.15 19.1 16.15V11.3M11.15 12.7L19.1 4.85M14.45 4.85H19.1V9.5"/>',
	back: '<path stroke-width="1.5" d="M11.4 7.4L5.95 12L11.4 16.6M5.95 12H18.05"/>',
	chev: '<path stroke-width="1.3" d="M10.2 8.4L13.8 12L10.2 15.6"/>',
	upc: '<circle cx="12" cy="12" r="9.4"/><path d="M12 16.5v-9M8 11.5l4-4 4 4"/>',
	ellipsis: '<g fill="currentColor" stroke="none"><circle cx="6.2" cy="12" r="1.55"/><circle cx="12" cy="12" r="1.55"/><circle cx="17.8" cy="12" r="1.55"/></g>',
};

const SCRIPT = `
for (const form of document.querySelectorAll("form[data-confirm]")) {
  form.addEventListener("submit", (ev) => {
    if (!confirm(form.dataset.confirm)) ev.preventDefault();
  });
}
`;

const CSS = `
body.agent{--ink:#060913;--muted:#4f5b79;--line:#ebeef3;--line-2:#f0f2f5;background:#f9f9fa;font-size:15px}
.agent .bc{display:flex;align-items:center;gap:13px;height:20px;margin:1px 0 15px;color:#667085;font-size:14px;letter-spacing:-.02em}
.agent .bc a{display:flex;align-items:center;gap:13.4px;color:inherit;font-size:13.75px;letter-spacing:0;text-decoration:none}
.agent .bc .ic{width:24px;height:24px;margin:0 -4px}
.agent .bc a .ic{width:24px;height:24px;margin:0 0 0 -5px}
.agent .bc b{margin-left:3.3px;color:var(--ink);font-size:14.75px;font-weight:500;letter-spacing:-.05em}
.agent .nt{margin-bottom:14px;padding:12px 16px;border:1px solid #dae7f9;border-radius:12px;background:#f3f8fe;font-size:14px;color:#1c3a78}
.agent .card{border-radius:9px;background:#fefefe;border-color:#eff1f6}
.agent .sum{padding:22px 16px 22px 16px}
.agent .top{display:flex;align-items:center;justify-content:space-between;gap:16px}
.agent .who{display:flex;align-items:center;gap:24.5px}
.agent h1{font-size:36.75px;line-height:44px;font-weight:700;letter-spacing:-.005em}
.agent .who .as{gap:13.5px;height:35px;padding:0 16px 0 14.5px;border-radius:12px;background:#e0f9ec;font-size:15px;letter-spacing:-1.05px}
.agent .who .as.revoked{background:#fee6e7}
.agent .who .as.offline{background:#eceef2}
.agent .who .as b{height:auto;padding:0;background:none;line-height:35px}
.agent .who .as.online b{color:#07884f}
.agent .who .as.online i{background:#0db066}
.agent .who .as i{position:relative;top:1.2px;width:14px;height:14px}
.agent .acts{display:flex;align-self:flex-start;gap:18px;margin-top:-1px}
.agent .acts form{display:flex}
.agent .bt{display:inline-flex;align-items:center;justify-content:center;gap:12.45px;height:39px;padding:0 15.9px 0 13.1px;border:1px solid #dfe2ea;border-radius:9px;background:#fff;color:var(--ink);font:inherit;font-size:14px;font-weight:500;letter-spacing:-.77px;text-decoration:none;white-space:nowrap;cursor:pointer}
.agent .bt .ic{width:21.8px;height:21.8px;color:#2b3347}
.agent .acts .bt .ic{width:24px;height:24px;margin:0 -1.1px;color:#060d20}
.agent .bt.dg{gap:12.3px;padding:2px 11.5px 0 12.4px;border-color:#f6a9ad;background:#fef3f3;color:#f1080d;font-size:13px;font-weight:600;letter-spacing:-.195px}
.agent .bt.dg .ic{margin:0 -2.4px 0 .2px;color:#ee050b}
.agent .bt.off{border-color:#eceef3;background:#f6f7fa;color:#a3a9bb;cursor:default}
.agent .bt.off .ic{color:#c5cad6}
.agent .inf{display:grid;grid-template-columns:215px 158px 186px 142px 176px 1fr;margin-top:24px}
.agent .inf>div{min-width:0;min-height:73px;padding:0 0 0 22px;border-left:1px solid #e9ecf2}
.agent .inf>div:first-child{padding-left:1px;border-left:0}
.agent .inf>div:nth-child(2){padding-left:21.3px}
.agent .inf>div:nth-child(3){padding-left:23.5px}
.agent .inf>div:nth-child(4){padding-left:20.9px}
.agent .inf>div:nth-child(5){padding-left:20.65px}
.agent .inf>div:nth-child(6){padding-left:21.1px}
.agent .inf dt{font-size:14px;line-height:20px;letter-spacing:-.7px;color:#5e6886}
.agent .inf dd{margin-top:6px;font-size:15px;line-height:21px;letter-spacing:-.3px;color:#0d1428}
.agent .inf>div:nth-child(2) dd{font-weight:500;letter-spacing:-.075px}
.agent .inf>div:nth-child(5) dd{margin-left:3.05px}
.agent .inf>div:nth-child(6) dd{margin-left:.85px}
.agent .inf>div:nth-child(6) dt{letter-spacing:-.95px}
.agent .inf .pf dt{margin-top:-.8px;font-weight:500;letter-spacing:-.35px}
.agent .inf .pf dd{margin-top:3.6px}
.agent .inf .pf span{display:block;line-height:24px;letter-spacing:-.39px;color:#4d566f}
.agent .inf .pf span+span{margin-top:-1.2px;font-size:16px;letter-spacing:-.8px}
.agent .inf .vv{display:flex;align-items:center;gap:12.8px;margin:-1.3px 0 0 1px;font-weight:500;letter-spacing:.3px}
.agent .up{position:relative;top:-1.5px;display:block;width:max-content;height:24px;padding:0 8px;border-radius:8px;background:#feeccb;color:#a7400a;font-size:13.25px;font-weight:400;letter-spacing:-.265px;line-height:24px}
.agent .us{display:block;margin:0 0 0 50px;font-size:12.75px;letter-spacing:-.64px;color:#6f7a9a}
.agent .ls{display:flex;align-items:center;gap:10.5px;letter-spacing:-.525px}
.agent .ls span{position:relative;top:-.7px}
.agent .ls i{width:9px;height:9px;border-radius:50%;background:#0ab468}
.agent .ls.off i{background:#8b94a8}
.agent .pb{display:flex;align-items:flex-start;gap:10px;margin-top:3.5px}
.agent .pb .av{position:relative;flex:none;width:28px;height:28px;overflow:hidden;border-radius:50%;background:#e3e8f1}
.agent .pb .av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.agent .pb b{display:block;font-size:14.25px;line-height:20px;font-weight:500;letter-spacing:-.855px;color:#10162a}
.agent .pb small{display:block;margin-top:2.2px;font-size:13px;line-height:18px;letter-spacing:-.13px;color:#717c9d}
.agent .sec{display:flex;gap:13px;height:52px;margin-top:4px;border-bottom:1px solid #e9ecf2}
.agent .sec a{display:flex;align-items:center;margin-bottom:1px;padding:3.8px 15px 0;border-bottom:3px solid transparent;font-size:14px;color:#5e688a;text-decoration:none}
.agent .sec a.on{border-color:#fb4e1a;color:var(--ink);font-size:14.75px;font-weight:500;letter-spacing:-.045em}
.agent .sec a:nth-child(2){margin-left:-1.67px;font-size:14.75px;letter-spacing:-.065em}
.agent .sec a:nth-child(3){margin-left:2.62px;padding-top:1.9px;letter-spacing:-.015em}
.agent .sec a:nth-child(4){margin-left:3.48px;padding-top:1.9px;letter-spacing:-.02em}
.agent .pn{margin-top:18px;padding:17px 14px 15px 16px}
.agent .ph2{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:0 0 0 2.3px}
.agent .ph2 h2{font-size:20.25px;line-height:26px;font-weight:600;letter-spacing:-.64px;color:#030615}
.agent .ph2 p{margin-top:4.5px;font-size:14px;letter-spacing:-.05px;color:#51607f}
.agent .ph2 .bt{height:37px;gap:10.3px;margin:-2px -2px 0 0;padding:1px 9.5px 0 11px;border-color:#eaedf2;font-size:13px;letter-spacing:-.65px;color:#091227}
.agent .ph2 .bt .ic{width:24px;height:24px;margin:-3px 0 0 -.4px}
.agent .ph2 a.vl{display:inline-flex;align-items:center;gap:7.5px;margin:6.1px 5px 0 0;color:#0257f8;font-size:15px;letter-spacing:-.75px;text-decoration:none}
.agent .ph2 a.vl .ic{width:19px;height:19px;margin:1.8px 0 0 .4px}
.agent .tw{margin-top:14.5px;border:1px solid #f0f3f7;border-radius:10px;overflow:hidden}
.agent table{table-layout:fixed;width:100%;border-collapse:collapse}
.agent th,.agent td{padding:0;text-align:left;vertical-align:middle;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent th{height:35.2px;padding-top:2px;background:#f9fafc;border-bottom:1px solid #f0f3f7;font-size:12.25px;font-weight:450;color:#5f6987;text-transform:none;letter-spacing:0}
.agent td{height:44.7px;border-top:1px solid #f0f3f7;font-size:13.2px;font-weight:450;color:#08102b}
.agent .bt2 th:nth-child(1){letter-spacing:-.27px}
.agent .bt2 th:nth-child(2){letter-spacing:-.66px}
.agent .bt2 th:nth-child(3){letter-spacing:-.16px}
.agent .bt2 th:nth-child(4){letter-spacing:-.45px}
.agent .bt2 th:nth-child(5){letter-spacing:-.43px}
.agent .bt2 td:nth-child(3){letter-spacing:-.58px}
.agent .bt2 td:nth-child(4){letter-spacing:-.05px;color:#4f5a7c}
.agent tbody tr:first-child td{border-top:0}
.agent tbody tr:hover{background:none}
.agent td.mn,.agent th.mn{overflow:visible}
.agent .bt2 th:first-child,.agent .bt2 td:first-child{padding-left:20px}
.agent .rt2 th:first-child{padding-left:13px}
.agent .rt2 td:first-child{padding-left:10.5px}
.agent .rt2 th:nth-child(1){letter-spacing:-.1px}
.agent .rt2 th:nth-child(2){letter-spacing:-.33px}
.agent .rt2 th:nth-child(3),.agent .rt2 th:nth-child(4){letter-spacing:-.3px}
.agent .rt2 th:nth-child(6){letter-spacing:-.14px}
.agent .rt2 th:nth-child(7){letter-spacing:-.26px}
.agent .rt2 th:nth-child(8){letter-spacing:-.13px}
#runs .ph2 p{margin-top:5.5px;letter-spacing:-.13px}
#runs .tw{margin-top:15.5px}
.agent .rt2 td:nth-child(2){font-size:13.5px;font-weight:400;letter-spacing:-.675px;color:#02081e}
.agent .rt2 td:nth-child(3){font-size:13.5px;font-weight:400;letter-spacing:-.945px}
.agent .rt2 td:nth-child(5){font-size:14px;font-weight:400;padding-left:1.3px;letter-spacing:-.7px;color:#00041a}
.agent .rt2 td:nth-child(6){font-size:13.5px;letter-spacing:-.405px;color:#5f6b90}
.agent .rt2 td:nth-child(7){letter-spacing:-.4px;color:#646e90}
.agent .rt2 td:nth-child(8){font-size:13.5px;padding-left:0;letter-spacing:-.405px;color:#6b7597}
.agent .rt2 td:not(:first-child){padding-top:2px}
.agent .rt2 tbody tr:nth-child(n+2) td:not(:first-child){padding-top:1px;padding-bottom:1px}
.agent .rt2 tbody tr:nth-child(n+2) .mnu summary{margin-top:0}
.agent .rt2 th{height:36.2px}
.agent .rt2 tbody tr:nth-child(1) td{height:43px}
.agent .rt2 tbody tr:nth-child(2) td,.agent .rt2 tbody tr:nth-child(3) td,.agent .rt2 tbody tr:nth-child(5) td{height:44px}
.agent .rt2 tbody tr:nth-child(4) td{height:46px}
#runs{padding-bottom:19px}
.agent .rt2 .mnu summary{margin:2.8px 0 0 18.1px}
.agent .rp{gap:11.3px;min-width:0;height:26px;margin:-3px 0;padding:0 0 0 6px;font-size:12px;font-weight:500;letter-spacing:-.42px;line-height:26px}
.agent .rp .ic{width:18.5px;height:18.5px}
.agent .rp.ok{background:#dff7e9;color:#09804c;width:94px;min-width:0}
.agent .rp.rn{background:#e6f0fe;color:#0a57f8;width:94px;min-width:0}
.agent .rp.fl{background:#ffe5e5;color:#f5080a;width:82px;min-width:0;font-size:11.75px;letter-spacing:-.35px}
.agent .rp.cn{background:#f1f2f5;color:#344262;width:93px;min-width:0;font-size:11px;font-weight:400;letter-spacing:-.38px}
.agent .rp.sp{background:#f0e8fe;color:#4e1aef;width:104px;min-width:0;font-size:11px;letter-spacing:-.33px}
.agent .rp.gt,.agent .rp.qd,.agent .rp.sk,.agent .rp.it,.agent .rp.vf{min-width:0}
.agent .gh{display:flex;align-items:center;gap:14px;letter-spacing:-.61px;color:#00041a}
.agent .gh .ic{width:24px;height:24px;margin:-1px 2.3px 0 -1.26px;color:#060606}
.agent .bch{display:inline-block;box-sizing:border-box;height:24px;padding:0 9.9px 0 8.2px;border:1px solid #f5f6f8;border-radius:5.5px;background:#edeef1;color:#4a5268;font-size:12px;font-weight:500;letter-spacing:-.55px;line-height:22px}
.agent .chip{display:inline-block;box-sizing:border-box;height:24px;margin-left:5px;padding:0 8.8px 0 8.55px;border:1px solid transparent;border-radius:6.4px;font-size:12px;line-height:21px;font-weight:500;letter-spacing:-.15px;vertical-align:middle}
.agent .chip.stg{background:#e1edfe;border-color:#f5f8fe;color:#0859fa}
.agent .chip.prev{background:#ebe2fe;border-color:#f4f0fe;color:#270eb4}
.agent .chip.prod{background:#fee7e7;border-color:#fef5f5;color:#f4070b}
.agent .ub{display:inline-block;width:68px;height:30px;padding:2px 0 0;border:1px solid #f0f2f6;border-radius:4px;background:#fff;color:#101830;font:inherit;font-size:12px;letter-spacing:-.2px;cursor:pointer}
.agent .bt2 col.c1{width:263px}
.agent .bt2 col.c2{width:174px}
.agent .bt2 col.c3{width:279px}
.agent .bt2 col.c4{width:216px}
.agent .bt2 col.c5{width:99px}
.agent .rt2 col.c1{width:134px}
.agent .rt2 col.c2{width:128px}
.agent .rt2 col.c3{width:88px}
.agent .rt2 col.c4{width:109px}
.agent .rt2 col.c5{width:235px}
.agent .rt2 col.c6{width:134px}
.agent .rt2 col.c7{width:94px}
.agent .rt2 col.c8{width:131px}
.agent .ubf{display:inline-flex}
.agent .mnu summary .ic{width:24px;height:24px;color:#3d4d82}
.agent .bt2 .mnu summary{margin:1.4px 0 0 26.95px}
.agent .rt2 .sha-b,.agent .rt2 .sha-t{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;letter-spacing:1.1px;color:#5e6884}
.agent .rt2 .sha-b{padding:0;border:0;background:none;cursor:pointer}
.agent .sha-b:not([hidden])+.sha-t{display:none}
.agent .rt2 .pr{color:#1253cf;font-weight:500;text-decoration:none}
.agent .rt2 .br{color:#3c4560}
.agent .rt2 td a.rp{text-decoration:none}
.agent .none{padding:28px 0;text-align:center;color:var(--muted)}
.agent .mt{margin-top:17px;padding:12px 16.5px 15px 15.5px}
#maintenance .ph2 h2{font-size:19.5px;font-weight:650;letter-spacing:-.585px}
#maintenance .ph2 p{margin-top:2.1px;font-size:14px;letter-spacing:-.165px;color:#5b658d}
.agent .mg{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:13.4px}
.agent .mc{display:flex;gap:19.2px;padding:10px 13.5px 11px;border:1px solid #f0f3f6;border-radius:9px}
.agent .mc .ico{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:50%;background:#f3f4f7;color:#0b1022}
.agent .mc .ico.up2{background:#e7f8fd;color:#08a9e6}
.agent .mc .ico .ic{width:28px;height:28px;margin-left:4.2px}
.agent .mc .ico.up2 .ic{width:26px;height:26px;margin-left:0}
.agent .mc div{min-width:0;flex:1}
.agent .mc b{display:block;margin-top:3px;font-size:14.5px;line-height:20px;font-weight:500;letter-spacing:-.29px;color:#040715}
.agent .mc p{margin:2px 0 7px;font-size:12px;line-height:18px;letter-spacing:-.06px;color:#657191}
.agent .mc .cb{height:39px;margin-left:-2px;padding:0 4.8px 0 9.8px;border-color:#eff2f7;border-radius:4px;background:#f9fafb;color:#3d4768;font-size:12px}
.agent .mc .cb code{padding-top:3px}
.agent .mc .cb .cp{margin-top:-2.2px}
.agent .mc .cb .cp .ic{width:22px;height:22px}
@media (max-width:900px){
.agent .top{flex-wrap:wrap}
.agent h1{font-size:30px;line-height:36px}
.agent .inf{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 0}
.agent .inf .vv{flex-wrap:wrap;gap:6px}
.agent .us{margin-left:0}
.agent .inf>div{padding:0 14px}
.agent .up{white-space:nowrap}
.agent .inf>div:nth-child(odd){padding-left:0;border-left:0}
.agent .sec{flex-wrap:wrap;gap:8px 18px;height:auto;overflow:visible}
.agent .sec a{min-height:44px;margin-bottom:0}
.agent td a.rp{box-sizing:border-box;height:44px;margin:0;border-block:9px solid transparent;background-clip:padding-box}
.agent .rt2 .sha-b,.agent .rt2 a.pr{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px}
.agent .gh .ic{flex:none}
.agent .ph2{flex-wrap:wrap}
.agent .mg{grid-template-columns:minmax(0,1fr)}
.agent .mc{min-width:0}
.agent .tw{overflow:visible;border:0;border-radius:0}
.agent table{min-width:0}
.agent :is(table,tbody,tr,td){display:block;width:auto}
.agent :is(thead,col){display:none}
:is(#bindings,#runs) tr{position:relative;padding:12px 14px;border-top:1px solid #f0f3f7}
:is(#bindings,#runs) tbody tr:first-child{border-top:0}
:is(#bindings,#runs) td{display:flex;align-items:center;justify-content:space-between;gap:12px;height:auto;min-height:32px;padding:4px 0;border:0;overflow:visible;white-space:normal;text-align:right;text-overflow:clip;overflow-wrap:anywhere}
:is(#bindings,#runs) td[data-l]::before{content:attr(data-l);flex:none;font-size:12.5px;font-weight:500;letter-spacing:0;color:#5f6987;text-align:left}
:is(#bindings,#runs) td:first-child{padding-right:52px}
:is(#bindings,#runs) td.mn{position:absolute;top:8px;right:8px;min-height:0;padding:0}
:is(#bindings,#runs) td.none{display:block;text-align:center}
#bindings td:first-child{flex-direction:column;align-items:flex-start;gap:6px;text-align:left}
#bindings td:nth-child(3){flex-wrap:wrap;justify-content:flex-end;overflow-wrap:normal}
#bindings td:nth-child(3)::before{margin-right:auto}
.agent .gh{min-width:0;text-align:left;overflow-wrap:anywhere}
.agent .bch{display:block;height:auto;min-height:24px;max-width:100%;padding-top:2px;padding-bottom:2px;line-height:18px;text-align:left;overflow-wrap:anywhere}
.agent .chip{flex:none;white-space:nowrap}
.agent .rp.fl,.agent .rp.cn,.agent .rp.sp{font-size:12px}
.agent .ub{width:auto;min-width:88px;min-height:44px}
.agent .bt{min-height:44px}
.agent .ph2 .bt{margin:0}
.agent .ph2>.bt,.agent .acts,.agent .acts form,.agent .acts .bt{width:100%}
.agent .acts{flex-direction:column;align-items:stretch;align-self:stretch;gap:12px;margin-top:0}
.agent .acts .bt{height:48px}
.agent .ph2 a.vl{min-height:44px;margin:0}
.agent .who{flex-wrap:wrap;gap:12px 16px;min-width:0;max-width:100%}
.agent h1{min-width:0;overflow-wrap:anywhere}
.agent .bc{height:auto;min-height:44px;flex-wrap:wrap;gap:4px 8px}
.agent .bc a{min-height:44px}
.agent .bc b{overflow-wrap:anywhere}
.agent .inf dd{overflow-wrap:anywhere}
.agent .mc{gap:12px}
.agent .mc .cb{height:auto;min-height:52px;padding:4px 4px 4px 10px}
.agent .mc .cb code{padding-top:0}
.agent .mc .cb .cp{width:44px;height:44px;margin-top:0}
}
@media (min-width:901px) and (max-width:1100px){
.agent .rp.fl,.agent .rp.cn,.agent .rp.sp{font-size:12px}
.agent .bt2 col:nth-child(4),.agent .bt2 th:nth-child(4),.agent .bt2 td:nth-child(4),.agent .rt2 col:nth-child(4),.agent .rt2 th:nth-child(4),.agent .rt2 td:nth-child(4),.agent .rt2 col:nth-child(6),.agent .rt2 th:nth-child(6),.agent .rt2 td:nth-child(6){display:none}
}
@media (max-width:640px){
.agent .inf{grid-template-columns:minmax(0,1fr)}
.agent .inf>div:nth-child(n){padding-left:0;border-left:0;min-height:0}
}
@media (pointer:coarse){
.agent .bt,.agent .ub,.agent .sec a{min-height:44px}
}
${PILL_CSS}
${AGENT_UI_CSS}
${CAPACITY_CSS}
`;

/** "Aug 12, 2026, 10:24 AM" in UTC. */
function dateTimeOf(ms: number): string {
	const d = new Date(ms);
	const hour = d.getUTCHours() % 12 === 0 ? 12 : d.getUTCHours() % 12;
	const minute = String(d.getUTCMinutes()).padStart(2, "0");
	return `${dateOf(ms)}, ${hour}:${minute} ${d.getUTCHours() < 12 ? "AM" : "PM"}`;
}

function pairedCell(v: AgentDetailView): string {
	const id = v.agent.paired_by_github_id;
	const src = v.pairedBy === null ? `https://avatars.githubusercontent.com/u/${id}?s=64` : `https://github.com/${encodeURIComponent(v.pairedBy)}.png?size=60`;
	const name = v.pairedBy ?? D.pairedByUnknown(id);
	const at = v.agent.paired_at;
	return (
		`<div class="pb"><span class="av"><img src="${e(src)}" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer"></span>` +
		`<span><b>${e(name)}</b><small><time datetime="${new Date(at).toISOString()}">${e(dateTimeOf(at))}</time></small></span></div>`
	);
}

function infoRow(v: AgentDetailView): string {
	const a = v.agent;
	const I = D.info;
	const upgrade = a.revoked_at === null && upgradeHint(a.protocol_version, a.agent_version, v.latestAgentVersion) !== undefined;
	const version = a.agent_version === null ? nil() : e(a.agent_version);
	const hint = upgrade ? `<span class="up">${e(A.upgradeAvailable)}</span>` : "";
	const sub = upgrade ? `<span class="us">${e(A.upgradeCommand)}</span>` : "";
	const seen = a.revoked_at === null ? (a.last_seen_at === null ? e(A.neverSeen) : agoHtml(a.last_seen_at, v.now, MINUTES_AGO)) : `${e(A.revokedOn)} ${e(dateOf(a.revoked_at))}`;
	const cells: [string, string, string][] = [
		[I.version, `<span class="vv">${version}${hint}</span>${sub}`, ""],
		[I.hostname, a.hostname === null ? nil() : e(a.hostname), ""],
		[I.platform, platformLines(a) || nil(), "pf"],
		[I.protocol, a.protocol_version === null ? nil() : e(A.protocol(a.protocol_version)), ""],
		[I.lastSeen, `<span class="ls${a.status === "online" ? "" : " off"}"><i></i><span>${seen}</span></span>`, ""],
		[I.pairedBy, pairedCell(v), ""],
	];
	return `<dl class="inf">${cells.map(([t, html, cls]) => `<div${cls === "" ? "" : ` class="${cls}"`}><dt>${e(t)}</dt><dd>${html}</dd></div>`).join("")}</dl>`;
}

function summary(v: AgentDetailView, base: string): string {
	const a = v.agent;
	const revoked = a.revoked_at !== null;
	const open = `<a class="bt" href="${e(`${base}/runs?agent=${encodeURIComponent(a.agent_id)}`)}">${icon("out")}${e(D.open)}</a>`;
	const revoke = revoked
		? `<span class="bt off" aria-disabled="true">${icon("trash")}${e(D.revoke)}</span>`
		: `<form method="post" action="${e(`${base}/agents/${encodeURIComponent(a.agent_id)}/revoke`)}" data-confirm="${e(D.revokeConfirm)}"><input type="hidden" name="csrf" value="${e(v.csrf)}"><button class="bt dg" type="submit">${icon("trash")}${e(D.revoke)}</button></form>`;
	return (
		`<section class="card sum"><div class="top"><div class="who"><h1>${e(a.name)}</h1>${statusChip(a.status)}</div>` +
		`<div class="acts">${open}${revoke}</div></div>${infoRow(v)}</section>`
	);
}

function bindingRow(v: AgentDetailView, base: string, b: AgentBindingRow): string {
	const repo = b.full_name === null ? S.dashboard.unknownRepo : shortRepo(b.full_name);
	const env = b.target.startsWith("deploy:") ? b.target.slice("deploy:".length) : null;
	const kind =
		env === null
			? e(D.bindings.checks)
			: `${e(D.bindings.deploy)}<span class="chip ${Object.hasOwn(ENV_CLASS, env) ? ENV_CLASS[env] : ""}">${e(env)}</span>`;
	const branch = b.default_branch === null ? nil() : `<span class="bch">${e(b.default_branch)}</span>`;
	const unbind =
		`<form class="ubf" method="post" action="${e(`${base}/agents/${encodeURIComponent(v.agent.agent_id)}/bindings/unbind`)}">` +
		`<input type="hidden" name="csrf" value="${e(v.csrf)}"><input type="hidden" name="repo_id" value="${b.repo_id}"><input type="hidden" name="target" value="${e(b.target)}">` +
		`<button class="ub" type="submit" aria-label="${e(D.bindings.unbindLabel(repo))}">${e(D.bindings.unbind)}</button></form>`;
	const items: [string, string][] = [];
	if (b.full_name !== null) items.push([S.dashboard.githubRepoUrl(b.full_name), S.dashboard.menu.openOnGithub]);
	return (
		`<tr><td data-l="${e(D.bindings.cols.repo)}"><span class="gh">${icon("repo-mark", "gh")}${e(repo)}</span></td><td data-l="${e(D.bindings.cols.target)}">${branch}</td><td data-l="${e(D.bindings.cols.kind)}">${kind}</td>` +
		`<td data-l="${e(D.bindings.cols.since)}">${b.bound_at === null ? nil() : e(dateOf(b.bound_at))}</td><td data-l="${e(D.bindings.cols.actions)}">${unbind}</td><td class="mn">${items.length === 0 ? "" : rowMenu(items, null)}</td></tr>`
	);
}

function bindingsCard(v: AgentDetailView, base: string): string {
	const B = D.bindings;
	const c = B.cols;
	const head = [c.repo, c.target, c.kind, c.since, c.actions].map((t) => `<th>${e(t)}</th>`).join("");
	const body =
		v.bindings.length === 0
			? `<tr><td class="none" colspan="6">${e(B.none)}</td></tr>`
			: v.bindings.map((b) => bindingRow(v, base, b)).join("");
	const bind = v.agent.revoked_at === null ? `<a class="bt" href="${e(bindPath(v.account.id))}">${icon("link")}${e(B.bind)}</a>` : "";
	return (
		`<section class="card pn" id="bindings"><div class="ph2"><div><h2>${e(B.title)}</h2><p>${e(B.subtitle)}</p></div>${bind}</div>` +
		`<div class="tw"><table class="bt2"><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5"><col class="c6"></colgroup>` +
		`<thead><tr>${head}<th class="mn"></th></tr></thead><tbody>${body}</tbody></table></div></section>`
	);
}

function runRow(v: AgentDetailView, base: string, run: RunListRow): string {
	const href = runHref(base, run);
	const items: [string, string][] = [[href, S.dashboard.menu.viewRun]];
	const title = run.commit_title === null ? nil() : `<span title="${e(run.commit_title)}">${e(run.commit_title)}</span>`;
	const cells = [
		runPill(run.state, e(href)),
		`<span title="${e(run.repo_name ?? S.dashboard.unknownRepo)}">${e(shortRepo(run.repo_name))}</span>`,
		refCell(run),
		shaCell(run.sha),
		title,
		run.event === "" ? nil() : e(run.event.replaceAll("_", " ")),
		durationCell(run, v.now),
		run.started_at === null ? nil() : agoHtml(run.started_at, v.now, MINUTES_AGO),
	];
	const labels = [D.runs.cols.state, D.runs.cols.repo, D.runs.cols.ref, D.runs.cols.sha, D.runs.cols.title, D.runs.cols.event, D.runs.cols.duration, D.runs.cols.started];
	return `<tr>${cells.map((html, i) => `<td data-l="${e(labels[i] ?? "")}">${html}</td>`).join("")}<td class="mn">${rowMenu(items, href)}</td></tr>`;
}

function runsCard(v: AgentDetailView, base: string): string {
	const R = D.runs;
	const c = R.cols;
	const head = [c.state, c.repo, c.ref, c.sha, c.title, c.event, c.duration, c.started].map((t) => `<th>${e(t)}</th>`).join("");
	const body =
		v.runs.length === 0
			? `<tr><td class="none" colspan="9">${e(R.none)}</td></tr>`
			: v.runs.map((run) => runRow(v, base, run)).join("");
	const all = `<a class="vl" href="${e(`${base}/runs?agent=${encodeURIComponent(v.agent.agent_id)}`)}">${e(R.viewAll)}${icon("arrow")}</a>`;
	return (
		`<section class="card pn" id="runs"><div class="ph2"><div><h2>${e(R.title)}</h2><p>${e(R.subtitle(10))}</p></div>${all}</div>` +
		`<div class="tw"><table class="rt2"><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5"><col class="c6"><col class="c7"><col class="c8"><col class="c9"></colgroup>` +
		`<thead><tr>${head}<th class="mn"></th></tr></thead><tbody>${body}</tbody></table></div></section>`
	);
}

function maintenanceCard(v: AgentDetailView): string {
	const M = D.maintenance;
	const cell = (ic: string, cls: string, title: string, body: string, cmd: string) =>
		`<div class="mc"><span class="ico${cls}">${icon(ic)}</span><div><b>${e(title)}</b><p>${e(body)}</p>${copyBox(cmd)}</div></div>`;
	return (
		`<section class="card pn mt" id="maintenance"><div class="ph2"><div><h2>${e(M.title)}</h2><p>${e(M.subtitle)}</p></div></div>` +
		`<div class="mg">${cell("terminal", "", M.restart, M.restartBody, M.restartCommand(v.account.id))}` +
		`${cell("upc", " up2", M.upgrade, M.upgradeBody, M.upgradeCommand)}</div></section>`
	);
}

function sections(): string {
	const T = D.tabs;
	const links: [string, string][] = [["#", T.overview], ["#bindings", T.bindings], ["#runs", T.runs], ["#capacity", A.capacity.title], ["#maintenance", T.maintenance]];
	return `<nav class="sec" aria-label="${e(D.tabsLabel)}">${links.map(([href, label], i) => `<a href="${href}"${i === 0 ? ' class="on" aria-current="true"' : ""}>${e(label)}</a>`).join("")}</nav>`;
}

export function agentDetailPage(v: AgentDetailView): Promise<Response> {
	const base = `/app/${v.account.id}`;
	const crumb = `<div class="bc"><a href="${e(`${base}/agents`)}">${icon("back")}${e(D.breadcrumb)}</a>${icon("chev")}<b>${e(v.agent.name)}</b></div>`;
	const notice = v.notice === null ? "" : `<p class="nt" role="status">${e(v.notice)}</p>`;
	const main = `${crumb}${notice}${summary(v, base)}${sections()}${bindingsCard(v, base)}${runsCard(v, base)}${capacityCard(v.agent, v.now, v.csrf, base)}${maintenanceCard(v)}`;
	return appPage({
		title: v.agent.name,
		bodyClass: "agent",
		main,
		viewer: viewerOf(v, "agents"),
		init: initOf(v),
		css: CSS,
		icons: { ...AGENT_ICONS, ...PILL_ICONS, ...RUN_ICONS, ...ICONS, ...TRACED_ICONS },
		script: PAGE_SCRIPT + SCRIPT,
		avatars: true,
		forms: true,
	});
}
