// The pair-a-new-agent page: the install and connect commands with a one-time
// token, a live countdown, and a checklist that flips once the agent connects.
// Also the refusal page for the pair route. The token is a secret: it is only in
// this response, never in a URL.

import type { InstallationRow } from "../db/installations";
import { PAIR_TOKEN_TTL_MS } from "../pairing/tokens";
import { S } from "../strings";
import { PAIR_ICONS } from "./agent-pair-icons";
import { AGENT_ICONS, AGENT_UI_CSS, copyBox } from "./agent-ui";
import { accountNav, appPage, type DashboardChrome, initOf, PAGE_SCRIPT, viewerOf } from "./dashboard";
import { escapeHtml, page } from "./layout";
import { icon } from "./shell";

const P = S.agents.pairing;
const e = escapeHtml;

export interface PairView {
	account: InstallationRow;
	accounts: readonly InstallationRow[];
	login: string;
	chrome?: DashboardChrome;
	cookies?: string[];
	csrf: string;
	now: number;
	hubOrigin: string;
	token: string;
	expiresAt: number;
	/** Tokens an installation may create per hour. */
	perHour: number;
	/** Active agents a token can replace the credential of. */
	replaceable: readonly { agent_id: string; name: string }[];
	/** The agent this token replaces, if any. */
	replacing: string | null;
}

const PAIR_SCRIPT = `
const box = document.getElementById("pair");
if (box) {
  const end = Date.now() + Number(box.dataset.left);
  const ttl = Number(box.dataset.ttl);
  const bar = document.getElementById("pbar");
  const fmt = (ms) => Math.floor(ms / 60000) + "m " + String(Math.floor((ms % 60000) / 1000)).padStart(2, "0") + "s";
  let timer = 0;
  let poll = 0;
  const tick = () => {
    const left = Math.max(0, end - Date.now());
    for (const o of box.querySelectorAll("[data-tpl]")) o.textContent = o.dataset.tpl.replace("{t}", fmt(left));
    if (bar) bar.setAttribute("width", String(Math.round(245 * left / ttl)));
    if (left === 0) {
      clearInterval(timer);
      clearInterval(poll);
      box.dataset.state = "expired";
      for (const o of box.querySelectorAll("[data-when]")) o.hidden = o.dataset.when !== "expired";
    }
  };
  const check = async () => {
    const res = await fetch(box.dataset.poll, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok || !(await res.json()).paired) return;
    clearInterval(timer);
    clearInterval(poll);
    box.dataset.state = "done";
    for (const o of box.querySelectorAll("[data-when]")) o.hidden = o.dataset.when !== "done";
  };
  tick();
  timer = setInterval(tick, 1000);
  poll = setInterval(() => check().catch(() => {}), 3000);
}
`;

const CSS = `
body.agentp{--ink:#020514;--muted:#5d6788;--line:#e6e9f0;--line-2:#eef0f5;background:#f9fafb;font-size:15px}
.bc{display:flex;align-items:center;gap:13px;height:20px;margin-bottom:26px;color:#5d688e;font-size:15px;letter-spacing:-.04em}
.bc a{color:inherit;text-decoration:none}
.bc .ic{width:12px;height:12px}
.bc a .ic{width:24px;height:24px}
.bc a:first-child{margin:0 1.1px 0 -4.1px}
.bc>.ic{margin:0 .97px 0 -3.3px}
.bc .cur{letter-spacing:-.056em}
.bc .cur{color:var(--ink);font-weight:500}
.gb{display:inline-flex;align-items:center;gap:11.1px;height:43px;margin-top:3px;padding:0 18px 0 21.9px;border:1px solid #f1f4f8;border-radius:10px;background:#fff;color:var(--ink);font-size:14.75px;font-weight:500;letter-spacing:-.04em;text-decoration:none}
.gb .ic{width:24px;height:24px;margin-top:-2.2px}
.pc{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);border:1px solid #eef1f6;border-radius:10px;background:#fff}
.pc>*,.sp>div{min-width:0}
.pl{padding:20.5px 24px 34px 18.5px}
.pr{padding:22px 20px 0 21px;border-left:1px solid #eef1f6}
.sp{display:grid;grid-template-columns:42px 1fr;column-gap:14px;align-items:start;margin-bottom:34px}
.sp .n{display:grid;place-items:center;width:42px;height:42px;padding-top:2.3px;border-radius:50%;background:#e7f0fe;color:#034bf8;font-size:19px;font-weight:500}
.sp h2{margin:5px 0 0;font-size:20.25px;line-height:26px;font-weight:600;letter-spacing:-.032em;color:var(--ink)}
.sp p{margin:4.25px 0 0;font-size:14.5px;line-height:21px;letter-spacing:-.003em;color:#505c82}
.sp .cb{height:54px;margin-top:23.75px;padding:0 11.5px 0 15.5px;border-radius:7px;background:#f6f7fa;color:#2f3a5f}
.sp .cb .cp svg{width:24px;height:24px}
.sp .cb .cp{position:relative;left:-1px}
.sp:nth-of-type(2) .cb .cp{top:1.3px}
.sp .cb code{position:relative;top:1.7px;font-size:14.2px}
.sp:nth-of-type(2){margin-bottom:23.5px}
.sp:nth-of-type(2) .cb{margin-top:27.7px}
.sp:nth-of-type(4){margin-bottom:0}
.sp:nth-of-type(4) h2{margin-left:3.7px}
.sp:nth-of-type(4) p{margin-left:2.3px}
.pl .bx{margin:0 -15px 31px 36.5px;padding:18.3px 15.5px 17px 18.5px;border:1px solid #eef1f6;border-radius:12px;background:#fbfcfe}
.tk{display:grid;grid-template-columns:minmax(0,1fr) 245px;column-gap:22px;align-items:start}
.tk .lb{position:relative;top:.9px;left:-1.6px;font-size:14.2px;line-height:20px;letter-spacing:-.02em;color:#515c82}
.tk .cb{min-height:54px;margin-top:4.7px;padding:7px 12.5px 7px 12.5px;border:0;border-radius:7px;background:#f3f5f9;color:#2f3a5f;font-size:16.8px}
.tk .cb code{font-size:16.8px;line-height:20px;white-space:normal;overflow-wrap:anywhere;text-overflow:clip}
.tk .cb .cp svg{width:24px;height:24px}
.tk .cb .cp{position:relative;left:-1px;top:1px}
.ex{position:relative;padding-top:5.9px}
.ex .lb{position:relative;top:.5px;left:-2.1px;display:block;font-size:14px;line-height:20px;letter-spacing:-.03em;color:#586387}
.ex b{position:relative;left:-2px;display:block;margin-top:3.1px;font-size:22px;line-height:26px;font-weight:600;letter-spacing:-.045em;color:var(--ink)}
.ex svg{display:block;margin:9.2px 0 0 -2.5px}
.ex .rg{position:absolute;top:15.2px;right:2px;margin:0}
.ex .bg{fill:#d8dde8}
.ex .fg{fill:#0eae6a}
.rg button{display:inline-flex;align-items:center;gap:5.5px;height:39.5px;padding:0 11.8px 0 13.4px;border:1px solid #eaeef4;border-radius:7px;background:#fdfdfe;color:var(--ink);font:inherit;font-size:13.5px;font-weight:500;letter-spacing:-.065em;cursor:pointer}
.rg .ic{width:24px;height:24px;margin:0 0 0 -2.1px}
.rn{display:flex;align-items:center;gap:6.9px;margin:18px 0 0;padding:0 10px;height:37px;border-radius:8px;background:#f1f6fe;color:#4a5b92;font-size:13.5px;letter-spacing:-.02em}
.rn .ic{width:24px;height:24px;margin-left:-4px;color:#044cf2}
.wt,.ok{display:grid;grid-template-columns:35px 1fr;align-items:start;padding:15.8px 20px 19.2px;border-radius:10px;background:#f7f8fb}
.wt i,.ok i{width:12px;height:12px;margin:9.2px 0 0;border-radius:50%;background:#0cab69;box-shadow:0 0 0 6px #e3f6ec}
.wt b,.ok b{font-size:20.25px;line-height:28px;font-weight:600;letter-spacing:-.035em;color:var(--ink)}
.wt p,.ok p{grid-column:2;margin:6.2px 0 0 1.5px;font-size:14.75px;line-height:20.3px;letter-spacing:-.012em;color:#505c82}
.ok a{grid-column:2;margin-top:8px;color:#0b66fb;font-size:14px;font-weight:500;text-decoration:none}
.cl{list-style:none;margin:15.7px 0 0;padding:0 0 0 13px}
.cl li{display:flex;align-items:center;gap:19.4px;height:45.25px;font-size:14.6px;letter-spacing:-.02em;color:#566286}
.cl li::before{content:"";flex:none;width:27px;height:27px;box-sizing:border-box;border:2px solid #7a8399;border-radius:50%}
.cl li.dn,.cl li.cu{color:#070b1f;font-weight:500;letter-spacing:-.045em}
.cl li:nth-child(1){letter-spacing:-.061em}
.cl li:nth-child(2){letter-spacing:-.042em}
.cl li:nth-child(3){letter-spacing:-.034em}
.cl li:nth-child(4){letter-spacing:-.041em}
.cl li:nth-child(5){letter-spacing:-.029em}
.cl li:nth-child(2),.cl li:nth-child(4){position:relative;top:-1.3px}
.cl li.dn::before{display:none}
.cl li .pd{flex:none;width:30px;height:30px;margin:0 -1.5px;color:#0cab69}
.cl li.cu::before{border-color:#0b66fb}
.cl li span{margin-left:auto;padding-right:7.5px;font-size:14px;font-weight:400;letter-spacing:-.02em;color:#485678}
.rp2{position:relative;margin-top:31px;padding-top:27.8px}
.rp2::before{content:"";position:absolute;left:5px;right:7px;top:0;border-top:1px solid #eaedf3}
.rp2 h3{margin:0;font-size:17px;line-height:24px;font-weight:700;letter-spacing:-.035em;color:var(--ink)}
.rp2 p{margin:6.1px 0 11.1px;font-size:14.5px;line-height:20px;letter-spacing:-.035em;color:#505c81}
.rp2 form{display:flex;align-items:center;gap:8px;height:54px;margin:0 2px 0 1px;padding:0 10px 0 15px;border:1px solid #eef1f6;border-radius:10px;background:#f7f8fb}
.rp2 select{flex:1 1 90px;min-width:0;height:36px;padding:0;border:0;background:transparent;color:#2f3a5f;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:14.2px}
.rp2 button{flex:none;height:34px;padding:0 12px;border:1px solid #dfe3ea;border-radius:8px;background:#fff;color:var(--ink);font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.tr{margin-top:20px;padding:18.8px 20.5px 30px 21.5px;border:1px solid #eef1f6;border-radius:10px;background:#fff}
.tr h2{position:relative;left:-1.5px;margin:2px 0 0;font-size:26px;line-height:34px;font-weight:700;letter-spacing:-.02em;color:var(--ink)}
.tr .sb{position:relative;left:-1.5px;margin:2px 0 0;font-size:16.5px;line-height:24px;letter-spacing:-.025em;color:#546084}
.tg{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16.2px}
.tg div{display:grid;grid-template-columns:52px 1fr 16px;align-items:center;column-gap:16px;height:91px;padding:0 24px 0 20px;border:1px solid #eef1f6;border-radius:10px;background:#fff}
.tg .ti{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;background:#eef5fe;color:#1f52a0}
.tg .ti .ic{width:32px;height:32px}
.tg .t2 .ti .ic{width:28px;height:28px}
.tg .t2 .ti{background:#fdf0f0;color:#b62129}
.tg .t3 .ti{background:#eff0f4;color:#00021a}
.tg .t4 .ti{background:#e3f6fa;color:#1f535f}
.tg b{display:block;font-size:15px;line-height:20px;font-weight:700;letter-spacing:-.025em;color:var(--ink)}
.tg span.d{display:block;margin-top:5.9px;font-size:14px;line-height:20px;letter-spacing:-.041em;color:#5a668b}
.tg .ch2 .ic{position:relative;left:-2px;top:-2px;width:24px;height:24px;color:#415178}
.tg .ti{position:relative;top:1px}
.tg :is(.t1,.t3) .ti{left:-.5px}
.tg :is(.t2,.t4) .ti{left:2px}
.tg b{position:relative;top:-1px}
.tg :is(.t1,.t3) :is(b,.d){position:relative;left:-1.5px}
.tg :is(.t2,.t4) :is(b,.d){position:relative;left:1.5px}
.tg .d{top:-1.5px}
.fail{max-width:640px}
${AGENT_UI_CSS}
@media (max-width:900px){
body.agentp .ph{flex-direction:column;gap:12px}
.gb{margin-top:0}
.pc{grid-template-columns:minmax(0,1fr)}
.pl{padding:16px 14px 24px}
.pr{border-left:0;border-top:1px solid #eef1f6;padding:16px 14px}
.pl .bx{margin-left:0;margin-right:0}
.tk{grid-template-columns:minmax(0,1fr);margin-left:0;row-gap:14px}
.ex .rg{position:static;margin:12px 0 0}
.rg button{width:100%;height:48px;justify-content:center}
.rn{margin-left:0;height:auto;min-height:37px;padding:8px 10px}
.tg{grid-template-columns:1fr}
.tg div{grid-template-columns:44px 1fr 16px;column-gap:12px;padding:0 14px 0 12px}
.tg :is(.t1,.t2,.t3,.t4) .ti{width:44px;height:44px;left:0}
.tg :is(.t1,.t2,.t3,.t4) :is(b,.d){left:0}
.sp{grid-template-columns:34px 1fr;column-gap:10px}
.sp .n{width:34px;height:34px;font-size:16px}
.bc a:first-child{margin:0}
.bc>.ic{margin:0}
.tr h2{font-size:22px}
.sp .cb{height:auto;min-height:52px;padding:8px 12px}
.sp .cb code{white-space:normal;overflow-wrap:anywhere}
.sp:nth-of-type(4) h2,.sp:nth-of-type(4) p{margin-left:0}
.rp2::before{left:0;right:0}
.rp2 form{height:auto;flex-direction:column;align-items:stretch;gap:10px;margin:0;padding:12px}
.rp2 select{flex:none;width:100%;height:48px;padding:0 10px;border:1px solid #dfe3ea;border-radius:8px;background:#fff;font-size:16px}
.rp2 button{width:100%;height:48px;font-size:14px}
.gb{min-height:44px}
.bc{height:auto;min-height:44px;flex-wrap:wrap;gap:4px 8px}
.bc a{display:inline-flex;align-items:center;min-height:44px}
.bc a:first-child{min-width:44px;justify-content:center}
.ok a{display:inline-flex;align-items:center;min-height:44px}
.sp .cb,.tk .cb{padding:4px 4px 4px 12px}
.sp .cb .cp,.tk .cb .cp{width:44px;height:44px;top:0;margin:0}
.sp:nth-of-type(2) .cb .cp{top:0}
.sp .cb code,.tk .cb code{top:0}
.ex svg{max-width:100%}
}
@media (max-width:640px){
.sp{grid-template-columns:minmax(0,1fr)}
.sp .n{margin-bottom:8px}
.sp:nth-of-type(n) .cb{margin-top:16px}
.pl{padding:14px 8px 20px}
.pl .bx{margin:0 0 24px;padding:12px 8px}
}
`;

/** The shared command box, with this page's traced copy glyph. */
function box(text: string): string {
	return copyBox(text).replace("#i-copy", "#i-pcopy");
}

function stepList(v: PairView, base: string): string {
	const s = P.steps;
	const step = (n: number, title: string, body: string, extra: string) =>
		`<div class="sp"><span class="n">${n}</span><div><h2>${e(title)}</h2><p>${e(body)}</p>${extra}</div></div>`;
	const form = `<form class="rg" method="post" action="${base}/agents/pair"><input type="hidden" name="csrf" value="${e(v.csrf)}">${v.replacing === null ? "" : `<input type="hidden" name="replace" value="${e(v.replacing)}">`}<button type="submit">${icon("prefresh")}${e(P.regenerate)}</button></form>`;
	const total = Math.round(PAIR_TOKEN_TTL_MS);
	const left = Math.max(0, v.expiresAt - v.now);
	const bar = `<svg width="245" height="9" viewBox="0 0 245 9" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="245" height="9" rx="4.5"/><rect id="pbar" class="fg" width="${Math.round((245 * left) / total)}" height="9" rx="4.5"/></svg>`;
	const expiry = `<div class="ex"><span class="lb">${e(P.expires)}</span><b data-tpl="{t}">${minutesText(left)}</b>${form}${bar}</div>`;
	const token = `<div class="bx"><div class="tk"><div><div class="lb">${e(P.token)}</div>${box(v.token)}</div>${expiry}</div><p class="rn">${icon("pinfo")}${e(P.rateNote(v.perHour))}</p></div>`;
	const gone = `<p class="rn" data-when="expired" hidden>${e(P.expired)}</p>`;
	return (
		step(1, s.install.title, s.install.body, box(S.agents.installCommand(v.hubOrigin))) +
		step(2, s.connect.title, s.connect.body, box(S.agents.connectCommand(v.token))) +
		`${token.replace('<p class="rn">', '<p class="rn" data-when="live">')}${gone}` +
		step(3, s.wait.title, s.wait.body, "")
	);
}

/** "9m 42s": the countdown text, rendered on the server for the first paint. */
function minutesText(ms: number): string {
	const s = Math.floor(ms / 1000);
	return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function sidePanel(v: PairView, base: string): string {
	const left = Math.max(0, v.expiresAt - v.now);
	const c = P.checklist;
	const items = [
		`<li class="dn">${icon("pdone", "pd")}${e(c.created)}<span data-tpl="${e(c.remaining("{t}"))}">${e(c.remaining(minutesText(left)))}</span></li>`,
		`<li class="cu">${e(c.waiting)}</li>`,
		`<li>${e(c.verifying)}</li>`,
		`<li>${e(c.registering)}</li>`,
		`<li>${e(c.ready)}</li>`,
	].join("");
	const waiting = `<div class="wt" data-when="live"><i></i><b>${e(P.waiting)}</b><p>${e(P.waitingBody)}</p></div>`;
	const done = `<div class="ok" data-when="done" hidden><i></i><b>${e(P.connected)}</b><p>${e(P.connectedBody)}</p><a href="${base}/agents">${e(P.viewAgents)}</a></div>`;
	const opts = v.replaceable.map((a) => `<option value="${e(a.agent_id)}"${a.agent_id === v.replacing ? " selected" : ""}>${e(a.name)}</option>`).join("");
	const replace =
		v.replaceable.length === 0
			? `<p>${e(P.replace.none)}</p>`
			: `<p>${e(P.replace.body)}</p><form method="post" action="${base}/agents/pair"><input type="hidden" name="csrf" value="${e(v.csrf)}"><label class="sr" for="replace">${e(P.replace.label)}</label><select id="replace" name="replace">${opts}</select><button type="submit">${e(P.replace.submit)}</button></form>`;
	return `${waiting}${done}<ul class="cl" data-when="live">${items}</ul><div class="rp2"><h3>${e(P.replace.title)}</h3>${replace}</div>`;
}

function troubleCard(v: PairView): string {
	const tiles = P.trouble.tiles;
	const icons = ["pwifi", "pkey", "pterm", "pserver"];
	const cells = tiles
		.map((t, i) => `<div class="t${i + 1}"><span class="ti">${icon(icons[i] ?? "pinfo")}</span><span><b>${e(t.title)}</b><span class="d">${e(t.body(v.hubOrigin))}</span></span><span class="ch2">${icon("pchev")}</span></div>`)
		.join("");
	return `<section class="card tr"><h2>${e(P.trouble.title)}</h2><p class="sb">${e(P.trouble.subtitle)}</p><div class="tg">${cells}</div></section>`;
}

export function pairPage(v: PairView): Promise<Response> {
	const base = `/app/${v.account.id}`;
	const crumbs = `<nav class="bc" aria-label="${e(S.agents.detail.breadcrumb)}"><a href="${base}/agents" aria-label="${e(P.back)}">${icon("pback")}</a><a href="${base}/agents">${e(S.agents.detail.breadcrumb)}</a>${icon("pbc")}<span class="cur" aria-current="page">${e(P.breadcrumb)}</span></nav>`;
	const head = `<div class="ph"><div><h1>${e(P.title)}</h1><p class="sub">${e(P.subtitle)}</p></div><a class="gb" href="${e(S.site.docsUrl)}" rel="noopener noreferrer">${icon("pguide")}${e(P.guide)}</a></div>`;
	const left = Math.max(0, v.expiresAt - v.now);
	const poll = `${base}/agents/pair/status?after=${v.expiresAt - PAIR_TOKEN_TTL_MS}`;
	const card = `<section class="card pc" id="pair" data-state="live" data-left="${left}" data-ttl="${PAIR_TOKEN_TTL_MS}" data-poll="${e(poll)}"><div class="pl">${stepList(v, base)}</div><aside class="pr">${sidePanel(v, base)}</aside></section>`;
	return appPage({
		title: v.account.account_login,
		bodyClass: "agentp",
		main: `${accountNav(v.accounts, v.account.id)}${crumbs}${head}${card}${troubleCard(v)}`,
		viewer: viewerOf(v, "agents"),
		init: initOf(v),
		css: CSS,
		icons: { ...AGENT_ICONS, ...PAIR_ICONS },
		script: PAGE_SCRIPT + PAIR_SCRIPT,
		connect: true,
		forms: true,
	});
}

/** A refusal of the pair route: the message and a way back to the agents list. */
export function pairRefusal(installationId: number, title: string, message: string, status: number): Response {
	const back = `/app/${installationId}/agents`;
	return page(title, `<p>${e(message)}</p>\n<p><a href="${e(back)}">${e(P.back)}</a></p>`, { status });
}
