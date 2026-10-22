// The log viewer of one job of a run: breadcrumb, run facts, a toolbar and the log with a line number per line. The log arrives
// as lines of escaped HTML with the agent's timestamp split off (logs/render.ts); the page script (search, wrap, timestamps, follow,
// copy links) only improves it, so without it the log and every link still work. The states without a log to show (not uploaded
// yet, kept on the agent, expired, failed) say so in place of the log. Everything shown is data the hub stores.

import { CONFIG_JOB } from "../checks/map";
import type { InstallationRow } from "../db/installations";
import type { JobLogRow, RunListRow } from "../db/runs";
import type { LogLine } from "../logs/render";
import { S } from "../strings";
import {
	agoHtml,
	appPage,
	branchLabel,
	type DashboardChrome,
	durationText,
	initOf,
	PAGE_SCRIPT,
	repoText,
	shortRepo,
	statusCircle,
	viewerOf,
} from "./dashboard";
import { escapeHtml } from "./layout";
import { stateLook } from "./pills";
import { icon } from "./shell";

const D = S.dashboard;
const T = D.detail;
const L = D.logs;
const e = escapeHtml;

/** What the viewer has for the job's log. */
export type LogState = "available" | "queued" | "local" | "expired" | "failed";

export interface RunLogsView {
	account: InstallationRow;
	login: string;
	chrome?: DashboardChrome;
	cookies?: string[];
	now: number;
	run: RunListRow;
	jobs: readonly JobLogRow[];
	job: JobLogRow;
	state: LogState;
	/** The log's lines as escaped HTML (empty unless state is "available"). */
	lines: readonly LogLine[];
	/** True when the log has more lines than the viewer shows. */
	cut: boolean;
}

const ICONS: Record<string, string> = {
	copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6.5A2 2 0 0 0 13 4.5H6.5a2 2 0 0 0-2 2V13a2 2 0 0 0 2 2H9"/>',
	terminal: '<path d="M4 7l5 5-5 5M12 18h8"/>',
	download: '<path d="M12 4.8v9.3M7.8 9.9l4.2 4.2 4.2-4.2M4.6 14.4v3.1a2.2 2.2 0 0 0 2.2 2.2h10.4a2.2 2.2 0 0 0 2.2-2.2v-3.1"/>',
	link: '<path d="M10 14a4 4 0 0 0 5.7 0l3.3-3.3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0L5 13.3A4 4 0 0 0 10.7 19l1-1"/>',
	info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2M12 7.8v.1" stroke-width="2"/>',
	back: '<path d="M18.7 12H6.2M11.2 7.3 6.2 12l5 4.7"/>',
};

const CSS = `
body.logs{background:#fafafa;will-change:opacity}
body.logs .app{--ls:.116;--ly:1px;border-bottom-color:#edeff4}
body.logs .app .in{max-width:none;gap:0;padding:0 50px 0 45px;height:72px}
body.logs .tabs{margin-left:138px;gap:27px}
body.logs .tabs a{margin-bottom:-1px;padding:8px 8px 0;border-bottom-width:3px;font-size:14.5px;letter-spacing:.016em;color:#515b7e}
body.logs .tabs a.on{border-color:#ec491b;color:var(--ink)}
body.logs .rt{gap:39px;font-size:14.5px}
body.logs .rt a{position:relative;top:2px;color:#555f80}
body.logs .usr{width:48px;height:48px}
body.logs .usr .ic{width:28px;height:28px}
.main.logs{max-width:none;margin:0;padding:35px 34px 40px 44px}
.logs .bc{position:relative;top:-1.5px;display:flex;align-items:center;height:20px;margin-bottom:36px;color:#667085;font-size:15px;letter-spacing:-.02em}
.logs .bc a{display:flex;align-items:center;gap:16px;color:inherit;text-decoration:none}
.logs .bc .ic{width:16px;height:16px;margin:0 17px 0 9px}
.logs .bc a .ic{width:29px;height:29px;margin:-5px 0 -5px -5px}
.logs .bc a+.ic+a+.ic{margin-left:15px}
.logs .bc b{color:var(--ink);font-weight:500}
.logs .top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.logs .who{position:relative;top:1px;display:flex;align-items:center;gap:16.6px;min-height:42px}
.logs h1{margin-left:-2px;font-size:42px;line-height:44px;font-weight:700;letter-spacing:-.023em;word-spacing:1px}
.logs .who .st{display:inline-flex;align-items:center;gap:9px;height:39px;padding:0 16px 0 14px;border:1px solid transparent;border-radius:12px;background:#f1f2f4;color:#4b5563;font-size:14.5px;font-weight:500}
.logs .who .st.ok{border-color:#e4f7ed;background:#ddf7ea;color:#067643}
.logs .who .st.bad{background:#fdecec;color:#dc2626}
.logs .who .st.busy{background:#e8f0fe;color:#2563eb}
.logs .who .st.wait{background:#fff4e0;color:#b45309}
.logs .who .st.pur{background:#f1ebfe;color:#7c3aed}
.logs .acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:15px;margin:2px 2px 0 0}
.logs .bt{display:inline-flex;align-items:center;gap:10px;height:45px;padding:0 15px;border:1px solid #f2f4f8;border-radius:6px;background:#fefefe;color:var(--ink);font:inherit;font-size:15px;font-weight:500;letter-spacing:-.04em;text-decoration:none;white-space:nowrap;cursor:pointer}
.logs .acts a.bt{padding:0 17px 0 14px;letter-spacing:-.02em}
.logs .bt .ic{width:24px;height:24px;margin:0 -2px}
.logs .bt:hover{background:#fafbfc}
.logs .meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 0;margin-top:14px;color:#4b5563;font-size:15px}
.logs .meta>*+*{position:relative;margin-left:18px;padding-left:19px}
.logs .meta+.meta>:nth-child(2){margin-left:17px;padding-left:20.5px}
.logs .meta+.meta>:nth-child(3){margin-left:16.5px;padding-left:21px}
.logs .meta+.meta>:nth-child(4){margin-left:21px;padding-left:23px}
.logs .meta+.meta>:nth-child(5){margin-left:20px;padding-left:20px}
.logs .meta>*+*::before{content:"";position:absolute;left:0;top:50%;width:2px;height:15px;margin-top:-7px;background:#dbe0e8}
.logs .meta .gh{width:28px;height:28px;color:var(--ink)}
.logs .meta b{color:var(--ink);font-size:18px;font-weight:700;letter-spacing:-.03em}
.logs .meta .ttl{color:#515b7e;font-weight:500}
.logs .mono,.logs .vb{font-family:SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.logs .meta .mono{font-size:14px}
.logs .shaw{display:inline-flex;align-items:center;gap:7px}
.logs .rp{display:inline-flex;align-items:center;gap:10px}
.logs .cp{display:inline-grid;place-items:center;width:24px;height:24px;padding:0;border:0;background:none;color:#6b7280;cursor:pointer}
.logs .cp:hover{color:var(--ink)}
.logs .cp[data-done]{color:#15803d}
.logs .cp .ic{width:24px;height:24px}
.logs .person{display:inline-flex;align-items:center;gap:12px;letter-spacing:-.02em}
.logs .av{position:relative;display:inline-grid;place-items:center;flex:none;width:26px;height:26px;overflow:hidden;border-radius:50%;background:#e5e7eb;color:#4b5563;font-size:12px;font-weight:600}
.logs .av img{position:absolute;inset:0;width:100%;height:100%}
.logs .lc{margin:25px -1px 0 -7px;padding:19px 10px 18px 12px;border-color:#eceff4;border-radius:16px;background:#fefefe}
.logs .tb{display:flex;align-items:flex-start;gap:12px;height:50px;margin:-2px 9px 16px 7px;font-size:15px}
.logs .ctl{display:inline-flex;flex:none;align-items:center;gap:12px;height:49px;margin-top:1px;padding:0 17px;border:1px solid #e5e9f0;border-radius:7px;background:#fff;color:var(--ink);font:inherit;font-size:15px;font-weight:500;letter-spacing:-.03em;text-decoration:none;white-space:nowrap;cursor:pointer}
.logs .ctl .ic{width:24px;height:24px;margin:0 -2px}
.logs .ctl:hover{background:#fafbfc}
.logs .ctl[data-wrap]{width:63px;margin-right:-2px;padding:0 12.5px}
.logs .ctl[data-here]{width:114px;gap:7.5px;padding:0 13px;letter-spacing:-.06em}
.logs .ctl[data-ts]{width:114px;margin-right:7px;padding:0 14px}
.logs a.ctl{width:134px;padding:0 16px}
.logs a.ctl .ic{width:28px;height:28px;margin:0 -3.5px 0 -4.5px}
.logs .tg{width:118px;margin-right:-.5px;padding:0 14px 0 15px}
.logs .jsel{position:relative;height:50px;margin-top:0;width:153px;padding:0;border-color:#dbdfe8}
.logs .jsel select{width:100%;height:100%;padding:0 38px 0 16px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;appearance:none;cursor:pointer}
.logs .jsel select:disabled{cursor:default;opacity:1}
.logs .jsel .ic{position:absolute;right:8px;top:13px;width:23px;height:23px;pointer-events:none;color:#515b7e}
.logs .srch{height:50px;margin-top:0;width:337px;margin-right:5px;padding:0 13px 0 12px;border-color:#dbdfe8;cursor:text}
.logs .srch .ic{width:26px;height:26px;margin:0 -5px 0 -2px;color:#515b7e}
.logs .srch input{flex:1;min-width:0;border:0;outline:0;background:none;color:inherit;font:inherit;font-weight:400;letter-spacing:-.035em}
.logs .srch input::placeholder{color:#6b7694}
.logs .srch kbd{position:relative;top:1px;padding:4px 6.5px;border:1px solid #f0f2f6;border-radius:4px;background:#fdfdfe;color:#6b7694;font:inherit;font-size:12px;letter-spacing:.066em}
.logs .srch:focus-within{border-color:#2563eb}
.logs .tg[aria-pressed=true]{border-color:#0b64fd;background:#126afb;color:#fff}
.logs .tg .on,.logs .tg[aria-pressed=true] .off{display:none}
.logs .tg[aria-pressed=true] .on{display:inline}
.logs .tg .dot{display:none;width:9px;height:9px;border-radius:50%;background:#70dcb5}
.logs .tg[aria-pressed=true] .dot{display:block}
.logs .vw{overflow:hidden;border:1px solid #0c1019;border-radius:6px;background:#141920;color:#fefefe}
.logs .vh{display:flex;align-items:center;height:61px;padding:1px 18px 0 16px;border-bottom:1px solid #151a24;background:#232933}
.logs .vh .ic{position:relative;top:-1.5px;width:32px;height:32px;color:#fff}
.logs .vh b{margin-left:18px;color:#fff;font-size:16px;font-weight:600}
.logs .vh .stat{margin-left:auto;display:flex;align-items:center;gap:15px;color:#c0c8d9;font-size:15px}
.logs .vh .stat i{width:1px;height:15px;background:#525b6a}
.logs .vh .sz{word-spacing:3.6px}
.logs .vb{max-height:640px;overflow:auto;padding:6.7px 0 37.6px;font-size:15px;line-height:26.34px;tab-size:8}
.logs .ln{display:flex}
.logs .ln .n{flex:none;width:51px;color:#b6c2d3;text-align:right;text-decoration:none;user-select:none}
.logs .ln .n:hover{color:#fff}
.logs .ln .t{flex:1 0 auto;padding:0 24px 0 34px;white-space:pre}
.logs .ln .ts{flex:none;position:relative;top:-1px;width:95px;padding-left:33px;color:#a0aec2;font-size:13.5px;user-select:none}
.logs .nots .ln .ts{display:none}
.logs .ln:target,.logs .ln.hit{background:#2a3446}
.logs .wrap .ln .t{flex:1 1 0;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.logs .c0{color:#6e7681}.logs .c1{color:#ff7b72}.logs .c2{color:#9cf5ad}.logs .c3{color:#e3b341}.logs .c4{color:#5faff6}.logs .c5{color:#d2a8ff}.logs .c6{color:#56d4dd}.logs .c7{color:#fefefe}
.logs .c8{color:#8b949e}.logs .c9{color:#ffa198}.logs .c10{color:#a5f3b0}.logs .c11{color:#f2cc60}.logs .c12{color:#a5d6ff}.logs .c13{color:#e2c5ff}.logs .c14{color:#76e3ea}.logs .c15{color:#fff}
.logs .g0{background:#484f58}.logs .g1{background:#8e1519}.logs .g2{background:#196c2e}.logs .g3{background:#7d5e00}.logs .g4{background:#0c2d6b}.logs .g5{background:#6e40c9}.logs .g6{background:#0e5560}.logs .g7{background:#b1bac4}
.logs .g8{background:#6e7681}.logs .g9{background:#da3633}.logs .g10{background:#2ea043}.logs .g11{background:#bb8009}.logs .g12{background:#1f6feb}.logs .g13{background:#8957e5}.logs .g14{background:#1b7c83}.logs .g15{background:#fff}
.logs .fb{font-weight:700}.logs .fd{opacity:.7}.logs .fi{font-style:italic}.logs .fu{text-decoration:underline}
.logs .empty{display:flex;align-items:center;gap:20px;padding:40px 28px;border:1px solid var(--line);border-radius:10px;background:#fafbfd}
.logs .empty .ic{width:34px;height:34px;color:#667085}
.logs .empty b{display:block;font-size:17px;font-weight:600;letter-spacing:-.02em}
.logs .empty p{margin-top:4px;color:#667085;font-size:15px}
.logs .strip{display:flex;align-items:center;gap:10.5px;margin:17px 7px 0 6px;padding:0 13px 2px 20.5px;min-height:78px;border-radius:12px;background:#f7f8fb;color:#475171;font-size:15px;letter-spacing:-.037em}
.logs .strip>.ic{width:28px;height:28px;color:#46506c}
.logs .strip .msg{display:flex;flex:1;align-items:center}
.logs .strip .msg i{width:3px;height:3px;margin:1px 11px 0;border-radius:50%;background:#5f6588}
.logs .strip .msg i~i{margin-left:12.5px}
.logs .strip .bt{gap:10px;height:42px;padding:0 17.5px 0 13.5px;border-color:#e8ecf3;color:var(--ink);font-size:14.5px;letter-spacing:-.075em}
.logs .strip .bt .ic{width:27px;height:27px;margin:0 -2px;color:#2e374f}
.logs .note{margin:0 6px 12px;color:#667085;font-size:14px}
@media (max-width:900px){
body.logs .app .in{padding:0 16px;gap:18px;height:56px}
body.logs .tabs{flex:1 1 0;min-width:0;margin-left:0;gap:18px;overflow-x:auto;scrollbar-width:none}
body.logs .tabs a{flex:none;padding:4px 0 0}
body.logs .rt{flex:none;gap:12px}
body.logs .usr{width:34px;height:34px}
body.logs .usr .ic{width:19px;height:19px}
.main.logs{padding:16px 16px 40px}
.logs .bc{margin-bottom:20px}
.logs .top{flex-direction:column}
.logs .acts{justify-content:flex-start}
.logs h1{font-size:30px;line-height:34px}
.logs .who{flex-wrap:wrap;gap:12px}
.logs .lc{margin:16px 0 0;padding:10px 8px 12px}
.logs .meta{column-gap:16px;font-size:14px}
.logs .meta>*+*,.logs .meta+.meta>:nth-child(n){margin-left:0;padding-left:0}
.logs .meta>*+*::before{display:none}
.logs .tb{flex-wrap:wrap;gap:8px;height:auto;margin:0 0 12px}
.logs .jsel,.logs .srch{box-sizing:border-box;width:100%;min-width:0;max-width:100%;flex:1 1 100%;height:44px;margin:0}
.logs .jsel .ic{top:10px}
.logs .ctl,.logs .ctl[data-wrap],.logs .ctl[data-here],.logs .ctl[data-ts],.logs a.ctl,.logs .tg{width:auto;height:44px;margin:0;padding:0 14px}
.logs .vh{height:52px;padding:0 12px}
.logs .vh b{margin-left:10px}
.logs .vb{max-height:70vh;padding:8px 0 12px;font-size:13px;line-height:22px}
.logs .ln .n{width:44px}
.logs .ln .t{padding-left:14px}
.logs .ln .ts{width:76px;padding-left:14px}
.logs .strip{flex-wrap:wrap;gap:10px;margin:12px 0 0;padding:14px}
.logs .strip .msg{flex:1 1 0;flex-wrap:wrap;gap:2px 12px;min-width:0}
.logs .strip .msg i{display:none}
.logs .strip .bt{flex:1 1 100%;justify-content:center;margin:0}
}
@media (max-width:900px){
.logs .bc{flex-wrap:wrap;gap:0 0;row-gap:8px;height:auto;min-height:44px}
.logs .bc a{min-height:44px}
.logs .bc b{overflow-wrap:anywhere}
.logs .cp{position:relative}
.logs .cp::after{content:"";position:absolute;top:-10px;left:-10px;width:44px;height:44px}
.logs .who,.logs h1,.logs .meta>*{min-width:0;max-width:100%;overflow-wrap:anywhere}
.logs .acts{gap:12px}
.logs .meta{margin-top:20px}
.logs .jsel{height:46px}
.logs .jsel select,.logs .srch input{font-size:16px}
.logs .jsel .ic{top:11px}
.logs .srch{position:relative;flex-wrap:wrap;height:auto;padding:0 12px 0 40px}
.logs .srch .ic{position:absolute;left:10px;top:10px;width:24px;height:24px;margin:0}
.logs .srch input{flex:1 1 100%;height:44px}
.logs .srch kbd{top:0;margin:0 0 10px}
.logs .vh{flex-wrap:wrap;height:auto;min-height:52px;padding:8px 12px;gap:4px 10px}
.logs .vh .ic{top:0}
.logs .vh b{min-width:0;margin-left:0;overflow-wrap:anywhere}
.logs .vh .stat{min-width:150px;justify-content:flex-end}
.logs .vb{max-height:70vh;max-height:70dvh;overscroll-behavior:contain;counter-reset:ln;background:linear-gradient(90deg,#141920,#141920) left center/20px 100% no-repeat local,linear-gradient(270deg,#141920,#141920) right center/20px 100% no-repeat local,linear-gradient(90deg,rgba(255,255,255,.2),transparent) left center/12px 100% no-repeat scroll,linear-gradient(270deg,rgba(255,255,255,.2),transparent) right center/12px 100% no-repeat scroll,#141920}
.logs .lc:not(.wrap) .ln{width:max-content;min-width:100%}
.logs .ln{counter-increment:ln;cursor:pointer}
.logs .ln .n{display:none}
.logs .ln::before{content:counter(ln);position:sticky;left:0;z-index:1;flex:none;box-sizing:border-box;width:40px;padding-right:8px;background:#141920;color:#b6c2d3;text-align:right;user-select:none}
.logs .ln.hit::before,.logs .ln:target::before,.logs .ln:has(.n[data-done])::before{background:#2a3446}
.logs .ln:has(.n[data-done]){background:#2a3446}
.logs .ln .t{padding:0 12px 0 10px}
.logs .ln .ts{width:64px;padding-left:10px;font-size:12px}
.logs .strip .bt{height:44px}
}
`;

/**
 * The page script after the shared one: it reveals the controls that need it, makes the job select navigate, searches (marks the
 * lines that contain the text, Enter and Shift+Enter walk through them, Ctrl+F focuses the box), toggles wrapping, the timestamp column
 * and following the end of the log, copies a line's link when its number is clicked and copies the raw log fetched from the hub.
 */
const LOGS_SCRIPT = `
const lv = document.querySelector("[data-logs]");
if (lv) {
  for (const el of lv.querySelectorAll("[data-js]")) el.hidden = false;
  const pane = lv.querySelector("[data-pane]");
  const done = (b) => { b.dataset.done = "1"; setTimeout(() => { delete b.dataset.done; }, 1500); };
  const copy = (text, b) => navigator.clipboard.writeText(text).then(() => done(b)).catch(() => {});
  for (const s of lv.querySelectorAll("select[data-nav]")) s.addEventListener("change", () => { location.href = s.value; });
  for (const b of lv.querySelectorAll("[data-here]")) b.addEventListener("click", () => copy(location.href, b));
  for (const b of lv.querySelectorAll("[data-raw]")) {
    b.addEventListener("click", () => {
      fetch(b.dataset.raw, { credentials: "same-origin" }).then((r) => (r.ok ? r.text() : Promise.reject())).then((t) => copy(t, b)).catch(() => {});
    });
  }
  if (pane) {
    const lines = Array.from(pane.querySelectorAll(".ln"));
    const follow = lv.querySelector("[data-follow]");
    const wrap = lv.querySelector("[data-wrap]");
    const input = lv.querySelector("[data-search]");
    const hint = lv.querySelector("[data-hint]");
    let hits = [];
    let at = -1;
    const toEnd = () => { pane.scrollTop = pane.scrollHeight; };
    const setFollow = (on) => { follow.setAttribute("aria-pressed", on ? "true" : "false"); if (on) toEnd(); };
    follow.addEventListener("click", () => setFollow(follow.getAttribute("aria-pressed") !== "true"));
    for (const ev of ["wheel", "touchmove", "keydown"]) pane.addEventListener(ev, () => setFollow(false), { passive: true });
    setFollow(!location.hash);
    wrap.addEventListener("click", () => {
      const on = wrap.getAttribute("aria-pressed") !== "true";
      wrap.setAttribute("aria-pressed", on ? "true" : "false");
      lv.classList.toggle("wrap", on);
    });
    const small = matchMedia("(max-width: 900px)");
    if (small.matches) {
      wrap.setAttribute("aria-pressed", "true");
      lv.classList.add("wrap");
    }
    const stamps = lv.querySelector("[data-ts]");
    if (stamps) {
      stamps.addEventListener("click", () => {
        const on = stamps.getAttribute("aria-pressed") !== "true";
        stamps.setAttribute("aria-pressed", on ? "true" : "false");
        lv.classList.toggle("nots", !on);
      });
    }
    const go = (step) => {
      if (hits.length === 0) return;
      at = (at + step + hits.length) % hits.length;
      hits[at].scrollIntoView({ block: "center" });
      setFollow(false);
    };
    const find = () => {
      const q = input.value.toLowerCase();
      for (const l of hits) l.classList.remove("hit");
      hits = q === "" ? [] : lines.filter((l) => l.querySelector(".t").textContent.toLowerCase().includes(q));
      for (const l of hits) l.classList.add("hit");
      at = -1;
      hint.textContent = q === "" ? hint.dataset.idle : hits.length === 0 ? hint.dataset.none : hits.length === 1 ? hint.dataset.one : hint.dataset.many.replace("{n}", hits.length);
    };
    input.addEventListener("input", find);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); go(ev.shiftKey ? -1 : 1); }
      if (ev.key === "Escape") { input.value = ""; find(); }
    });
    document.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "f") { ev.preventDefault(); input.focus(); input.select(); }
    });
    pane.addEventListener("click", (ev) => {
      const n = ev.target.closest("a.n") || (small.matches && !getSelection().toString() ? ev.target.closest(".ln")?.querySelector("a.n") : null);
      if (n) copy(n.href, n);
    });
  }
}
`;

function avatar(login: string): string {
	const url = `https://github.com/${encodeURIComponent(login)}.png?size=52`;
	return `<span class="av">${e(login.slice(0, 1).toUpperCase())}<img src="${e(url)}" alt="" width="26" height="26" loading="lazy" referrerpolicy="no-referrer"></span>`;
}

function logPath(base: string, runId: string, job: string, tail = ""): string {
	return `${base}/runs/${encodeURIComponent(runId)}/logs/${encodeURIComponent(job)}${tail}`;
}

function metaRows(v: RunLogsView): string {
	const { run } = v;
	const branch = run.pr_number === null ? branchLabel(run.ref) : D.pullRequest(run.pr_number);
	const sha = run.sha.slice(0, 7);
	const copyBtn = `<button type="button" class="cp" data-copy="${e(run.sha)}" aria-label="${e(T.copySha)}" hidden>${icon("copy")}</button>`;
	const first = [
		`<span class="rp">${icon("github", "gh")}<b title="${e(repoText(run))}">${e(shortRepo(run.repo_name))}</b></span>`,
		`<span>${e(branch)}</span>`,
		`<span class="shaw"><span class="mono">${e(sha)}</span>${copyBtn}</span>`,
		run.commit_title === null ? "" : `<span class="ttl">${e(run.commit_title)}</span>`,
	];
	const second = [
		run.author_login === null ? "" : `<span class="person">${avatar(run.author_login)}${e(run.author_login)}</span>`,
		`<span>${e(run.event)}</span>`,
		`<span>${e(T.attempt(run.attempt))}</span>`,
		run.agent_name === null ? "" : `<span>${e(run.agent_name)}</span>`,
		run.duration_ms === null ? "" : `<span>${e(durationText(run.duration_ms))}</span>`,
		run.started_at === null ? "" : `<span>${agoHtml(run.started_at, v.now)}</span>`,
	];
	return `<div class="meta">${first.join("")}</div><div class="meta">${second.join("")}</div>`;
}

function jobSelect(v: RunLogsView, base: string): string {
	const shown = v.jobs.filter((j) => j.name !== CONFIG_JOB || j.name === v.job.name);
	const options = shown
		.map((j) => `<option value="${e(logPath(base, v.run.run_id, j.name, "/view"))}"${j.name === v.job.name ? " selected" : ""}>${e(j.name)}</option>`)
		.join("");
	const off = shown.length < 2 ? " disabled" : "";
	return `<label class="ctl jsel"><span class="sr">${e(L.jobLabel)}</span><select data-nav${off}>${options}</select>${icon("chevd")}</label>`;
}

function toolbar(v: RunLogsView, base: string): string {
	const select = jobSelect(v, base);
	if (v.state !== "available") return `<div class="tb">${select}</div>`;
	const download = logPath(base, v.run.run_id, v.job.name, "/download");
	return (
		`<div class="tb">${select}` +
		`<label class="ctl srch" data-js hidden>${icon("search")}<input type="search" data-search placeholder="${e(L.searchPlaceholder)}" aria-label="${e(L.searchLabel)}" autocomplete="off" spellcheck="false">` +
		`<kbd data-hint data-idle="${e(L.searchHint)}" data-none="${e(L.searchEmpty)}" data-one="${e(L.searchOne)}" data-many="${e(L.searchMany)}">${e(L.searchHint)}</kbd></label>` +
		`<button type="button" class="ctl tg" data-follow aria-pressed="false" data-js hidden><span class="dot"></span><span class="off">${e(L.follow)}</span><span class="on">${e(L.followOn)}</span></button>` +
		`<button type="button" class="ctl tg" data-wrap aria-pressed="false" data-js hidden>${e(L.wrap)}</button>` +
		(v.lines.some((l) => l.ts !== null) ? `<button type="button" class="ctl" data-ts aria-pressed="true" data-js hidden>${e(L.timestamps)}</button>` : "") +
		`<a class="ctl" href="${e(download)}">${icon("download")}${e(L.download)}</a>` +
		`<button type="button" class="ctl" data-here data-js hidden>${icon("link")}${e(L.copyLink)}</button></div>`
	);
}

const EMPTY: Record<Exclude<LogState, "available">, [title: string, body: string, glyph: string]> = {
	queued: [L.queuedTitle, L.queuedBody, "clock"],
	local: [L.localTitle, L.localBody, "terminal"],
	expired: [L.expiredTitle, L.expiredBody, "clock"],
	failed: [L.failedTitle, L.failedBody, "alert"],
};

function pane(v: RunLogsView): string {
	if (v.state !== "available") {
		const [title, body, glyph] = EMPTY[v.state];
		return `<div class="empty">${icon(glyph)}<div><b>${e(title)}</b><p>${e(body)}</p></div></div>`;
	}
	const showTs = v.lines.some((l) => l.ts !== null);
	const rows = v.lines
		.map((l, i) => {
			const n = i + 1;
			const ts = showTs ? `<span class="ts"${l.ts === null ? "" : ` title="${e(l.ts)}"`}>${l.ts === null ? "" : e(l.ts.slice(11, 19))}</span>` : "";
			return `<div class="ln" id="L${n}"><a class="n" href="#L${n}" aria-label="${e(L.lineLink(n))}">${n}</a>${ts}<span class="t">${l.text}</span></div>`;
		})
		.join("");
	const body = v.lines.length === 0 ? `<p class="t">${e(L.empty)}</p>` : rows;
	const stat = `${e(L.lines(v.lines.length))}<i></i><span class="sz">${e(L.size(v.job.log_bytes ?? 0))}</span>`;
	return (
		`<div class="vw"><div class="vh">${icon("terminal")}<b>${e(L.fileName(v.job.name))}</b><span class="stat">${stat}</span></div>` +
		`<div class="vb" data-pane tabindex="0" role="region" aria-label="${e(L.logLabel(v.job.name))}">${body}</div></div>`
	);
}

function strip(v: RunLogsView, base: string): string {
	if (v.state !== "available") return "";
	const raw = logPath(base, v.run.run_id, v.job.name);
	const notes = [L.viewer, L.ansi, L.clickLine].map((n) => `<span>${e(n)}</span>`).join("<i></i>");
	const note = v.cut ? `<p class="note">${e(L.cutNote(v.lines.length))}</p>` : "";
	return (
		`${note}<div class="strip">${icon("info")}<span class="msg">${notes}</span>` +
		`<button type="button" class="bt" data-raw="${e(raw)}" data-js hidden>${icon("download")}${e(L.copyRaw)}</button></div>`
	);
}

export function runLogsPage(v: RunLogsView): Promise<Response> {
	const { run } = v;
	const base = `/app/${v.account.id}`;
	const permalink = logPath(base, run.run_id, v.job.name, "/view");
	const commitUrl = run.repo_name === null ? null : D.githubCommitUrl(run.repo_name, run.sha);
	const github = commitUrl === null ? "" : `<a class="bt" href="${e(commitUrl)}" rel="noopener noreferrer">${icon("out")}${e(T.openInGithub)}</a>`;
	const main =
		`<div class="bc"><a href="${base}/runs">${icon("back")}${e(T.breadcrumb)}</a>${icon("chev")}` +
		`<a href="${e(`${base}/runs/${encodeURIComponent(run.run_id)}`)}">${e(T.run(String(run.run_number)))}</a>${icon("chev")}<b>${e(L.title)}</b></div>` +
		`<div class="top"><div class="who"><h1>${e(L.title)}</h1><span class="st ${stateLook(v.job.state).tone}"><span aria-hidden="true">${statusCircle(v.job.state)}</span>${e(v.job.state === "success" ? L.succeeded : (D.state[v.job.state] ?? v.job.state))}</span></div>` +
		`<div class="acts">${github}<button type="button" class="bt" data-copy="${e(permalink)}" hidden>${icon("link")}${e(L.copyPermalink)}</button></div></div>` +
		`${metaRows(v)}` +
		`<section class="card lc" data-logs>${toolbar(v, base)}${pane(v)}${strip(v, base)}</section>`;
	return appPage({
		title: L.pageTitle(v.job.name, repoText(run)),
		bodyClass: "logs",
		main,
		viewer: viewerOf(v, "runs"),
		init: initOf(v),
		css: CSS,
		icons: ICONS,
		script: PAGE_SCRIPT + LOGS_SCRIPT,
		connect: true,
		avatars: true,
		forms: v.chrome !== undefined,
	});
}
