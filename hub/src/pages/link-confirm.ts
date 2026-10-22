import { S } from "../strings";
import { SLACK_MARK } from "./brand";
import { escapeHtml } from "./layout";
import type { TracedGlyph } from "./link-confirm-art";
import { ARROW_GLYPH, BUILDING_GLYPH, GH_GLYPH, INFO_GLYPH, LINK_GLYPH, USER_GLYPH } from "./link-confirm-art";
import { blob, icon, shellResponse, siteNav } from "./shell";

// The start of /hookci me in the browser: names the Slack user being linked and asks before going to GitHub,
// so a link someone else sent cannot bind this browser's GitHub account to them unseen.
//
// The mockup is a 512px-wide layout drawn at 2x. The card is laid out in that 1x design (it is also the phone
// layout) and doubled with `zoom` from 900px up, where the nav and curves switch to their own 2x values.

const T = S.flow.link;
const e = escapeHtml;

const CSS = `
.p-confirm{--nh:55px;--nl:20px;--nr:20px;--bmw:27.4;--bww:79.5;--bgap:7.5;--bwy:4.4;--ly:0px;--nfs:12px;background:#fcfbfa}
.p-confirm .nav{background:#fefefe;border-bottom:1px solid #eceef2}
.p-confirm .links{gap:24px;margin-right:0}
.p-confirm .links a{color:#5f6a80}
.p-confirm{will-change:opacity}
.p-confirm .bg{background:${blob(154, 211, "-24px 516px", 0.296)},${blob(297, 166, "564px 279px", 0.283)}}
.p-confirm .mcurves{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.p-confirm .card{position:relative;z-index:2;width:min(387px,100% - 32px);margin:32px auto 32px;padding:40px 22px 23.25px;border:.5px solid #e8eaf0;border-radius:9px;background:#fefdfd;box-shadow:0 1px 2px rgba(15,20,29,.02),0 12px 36px rgba(15,20,29,.04);text-align:center}
.p-confirm .g{display:block;flex:none}
.p-confirm .pair{display:flex;align-items:center;justify-content:center}
.p-confirm .pair .t{display:grid;place-items:center;flex:none;width:69px;height:67px;border:.5px solid #f0f0f3;border-radius:16px;background:#f6f6f8;color:#0f141d}
.p-confirm .pair .t .ic{width:40.5px;height:40.5px;stroke:none;position:relative;top:-.25px}
.p-confirm .pair .j{display:flex;align-items:center;margin:0 5.3px 0 4.85px;color:#656f83}
.p-confirm .pair .j .g{position:relative;top:-.5px;margin:0 2.4px 0 1.4px}
.p-confirm .pair .j i{display:block;width:16.8px;height:4px;background:radial-gradient(circle,#d6dbe4 1.1px,transparent 1.5px) 0 50%/5.6px 4px repeat-x}
.p-confirm h1{margin-top:25.75px;font-size:25.15px;line-height:32px;font-weight:600;letter-spacing:-.03em;word-spacing:1.5px;position:relative;left:1px;top:.25px;color:#080d16}
.p-confirm .lede{max-width:290px;margin:7.65px auto 0;font-size:12px;line-height:17.3px;letter-spacing:.001em;position:relative;left:.5px;top:.25px;color:#646e84}
.p-confirm .facts,.p-confirm .note{margin-top:13px;border-radius:12px;background:#f6f7f9;text-align:left}
.p-confirm .facts{margin-top:24px;padding:0 14px}
.p-confirm .fact{display:flex;align-items:center;gap:18.45px;min-height:57px;padding:8px 1.25px 11px}
.p-confirm .fact:first-child{min-height:58px;padding:9.2px 1.25px 8px}
.p-confirm .fact+.fact{border-top:1px solid #eceef3}
.p-confirm .fact .l{display:block;font-size:10.55px;line-height:16px;letter-spacing:-.04em;color:#5e677c;position:relative;top:.5px}
.p-confirm .fact .v{display:block;margin-top:.55px;font-size:12.55px;line-height:18.7px;font-weight:500;letter-spacing:-.032em;color:#070a12;position:relative;top:.5px;overflow-wrap:anywhere}
.p-confirm .fact .g{color:#5c6575}
.p-confirm .fact:first-child .g{margin-top:-3px}
.p-confirm .fact+.fact .g{margin:1px -.5px 0 .5px}
.p-confirm .note{display:flex;gap:15.45px;padding:12.1px 15.25px 13.7px;font-size:10.6px;line-height:15.55px;letter-spacing:-.01em;position:relative;left:.5px;top:.25px;color:#566078}
.p-confirm .note p::first-line{letter-spacing:-.0235em}
.p-confirm .lede::first-line{letter-spacing:.0036em}
.p-confirm .note .g{margin-top:3.6px;color:#102446}
.p-confirm form{margin-top:12.25px}
.p-confirm .btn{--bh:41.5px;--br:8px;--bfs:13px;gap:7.975px;padding-left:.95px;background:#131922;letter-spacing:-.025em}
.p-confirm .btn .g{color:#fff}
.p-confirm .btn .arrow{margin-left:5px}
.p-confirm .btn span{margin-left:.475px;position:relative;top:.5px}
.p-confirm .btn.ghost{height:38.5px;margin-top:11.5px;border:.5px solid #d7dae2;border-radius:6.2px;background:#fefefe;font-size:13.4px;letter-spacing:-.05em;padding-right:2.7px}
@media (max-width:900px){
.p-confirm .links{display:flex}
}
@media (min-width:900px){
.p-confirm{--nh:111px;--nl:55.7px;--nr:56px;--bmw:55.37;--bww:159.11;--bgap:14.57;--bwy:7.65;--lx:-.55px;--ly:1.4px;--nfs:19.25px}
.p-confirm .nav{border-bottom-width:2px}
.p-confirm .bg{background:${blob(307, 422, "-47px 1031px", 0.296)},${blob(594, 332, "1128px 558px", 0.283)}}
.p-confirm .links{gap:65.3px;position:relative;left:-.55px}
.p-confirm .links a{position:relative;top:3.15px;letter-spacing:-.01em}
.p-confirm .links a:first-child{letter-spacing:-.03em;margin-right:1.75px}
.p-confirm .links a:last-child{letter-spacing:0}
.p-confirm .mcurves{left:50%;width:1024px;margin-left:-512px;height:1536px}
.p-confirm .card{zoom:2;margin:59.5px auto 78.5px;left:.5px}
}
@media (max-width:900px){
.p-confirm .links{display:none}
}
@media (max-width:899px){
.p-confirm .fact .l,.p-confirm .note{font-size:12px}
.p-confirm .fact .v,.p-confirm h1{overflow-wrap:anywhere}
}
`;

const GLYPHS: Record<string, TracedGlyph> = {
	gh: GH_GLYPH,
	link: LINK_GLYPH,
	building: BUILDING_GLYPH,
	user: USER_GLYPH,
	info: INFO_GLYPH,
	arrow: ARROW_GLYPH,
};

/** One `<symbol>` per traced glyph; they are traced in 2x crop pixels, so a glyph draws at half its crop size. */
const GLYPH_DEFS = `<svg class="defs" aria-hidden="true" focusable="false"><defs>${Object.entries(GLYPHS)
	.map(([name, g]) => `<symbol id="cg-${name}" viewBox="0 0 ${g.w} ${g.h}"><path fill="currentColor" fill-rule="evenodd" d="${g.d}"/></symbol>`)
	.join("")}</defs></svg>`;

const glyph = (name: string, cls = "", scale = 0.5) => {
	const g = GLYPHS[name];
	if (g === undefined) throw new Error(`no traced glyph ${name}`);
	return `<svg class="g ${cls || name}" width="${g.w * scale}" height="${g.h * scale}" viewBox="0 0 ${g.w} ${g.h}" aria-hidden="true" focusable="false"><use href="#cg-${name}"/></svg>`;
};

const MCURVES =
	`<svg class="mcurves" viewBox="0 0 1024 1536" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">` +
	`<path class="cv" d="M0 522C48 540 76 584 86 622S112 670 126 694"/><circle class="dt" cx="86.5" cy="622" r="10"/>` +
	`<path class="cv" d="M1024 216C960 250 930 310 916 360S900 390 898 400"/><circle class="dt" cx="917" cy="359.5" r="10"/>` +
	`<path class="cv" d="M900 1140C940 1170 956 1200 966 1216S1000 1260 1024 1282"/><circle class="dt" cx="967.5" cy="1217.5" r="10"/></svg>`;

/**
 * The start of /hookci me in the browser: names the Slack user being linked
 * and asks before going to GitHub, so a link someone else sent cannot bind
 * this browser's GitHub account to them unseen.
 */
export async function linkConfirmPage(state: string, workspace: string, slackUserId: string, cookie: string) {
	const fact = (g: string, label: string, value: string) =>
		`<div class="fact">${glyph(g)}<div><span class="l">${e(label)}</span><span class="v">${e(value)}</span></div></div>`;
	const body =
		`${GLYPH_DEFS}${siteNav("")}<main class="card"><div class="pair"><span class="t">${icon("slack")}</span><span class="j"><i></i>${glyph("link")}<i></i></span>` +
		`<span class="t">${glyph("gh")}</span></div><h1>${e(T.title)}</h1><p class="lede">${e(T.subtitle)}</p>` +
		`<div class="facts">${fact("building", T.workspace, workspace === "" ? T.workspaceFallback : workspace)}${fact("user", T.slackUser, slackUserId)}</div>` +
		`<div class="note">${glyph("info")}<div><p>${e(T.note)}</p></div></div>` +
		`<form method="post" action="/github/link/start"><input type="hidden" name="t" value="${e(state)}"><button class="btn" type="submit">${glyph("gh", "gh", 0.2675)}<span>${e(T.button)}</span>${glyph("arrow")}</button></form>` +
		`<a class="btn ghost" href="${e(new URL(S.site.docsUrl).origin)}" rel="noopener noreferrer">${e(T.cancel)}</a></main>${MCURVES}`;
	return shellResponse(
		{ title: T.title, bodyClass: "p-confirm", css: CSS, body, icons: { slack: SLACK_MARK } },
		{ cookies: [cookie] },
	);
}
