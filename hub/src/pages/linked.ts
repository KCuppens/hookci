import { S } from "../strings";
import { FLOW_ICONS } from "./flow-icons";
import { escapeHtml } from "./layout";
import { CURVE_LEFT, CURVE_RIGHT, SPARK_PATHS, TICK_D } from "./linked-art";
import { blob, icon, shellResponse, siteNav } from "./shell";

// The page that says the /hookci me link is made. Sizes are fitted to the mockup at 1536x1024.

const T = S.flow.link;
const e = escapeHtml;

const CSS = `
.p-linked{--nh:92px;--nl:110px;--nr:107.3px;--ls:.141;--bmw:54.3;--bww:131.5;--bgap:11.7;--bwy:10.7;--lx:-1.4px;--ly:-.2px;--ry:3px;--nfs:18px}
.p-linked{will-change:opacity}
.p-linked .nav{background:#fefefe;border-bottom:2px solid #eeeff3}
.p-linked .links{gap:52px;margin-right:0}
.p-linked .links a{letter-spacing:-.03em}
.p-linked .links a:first-child{margin-right:1.7px}
.p-linked .bg{background:${blob(276, 286, "52px 627px", 0.38)},${blob(244, 331, "1497px 359px", 0.35)},${blob(437, 222, "1680px 1029px", 0.49)}}
.p-linked .card{position:relative;z-index:2;width:min(706px,100% - 32px);left:1px;margin:76px auto 0;padding:87px 45px 62px;border:1px solid;border-color:#eaecf0 #e8eaee #edeef0 #e5e7ec;border-radius:14px;background:#fefefe;box-shadow:0 -1px 0 #eff0f2,inset 0 -1px 0 #eeeff2,inset 1px 0 0 #f7f8f9;text-align:center}
.p-linked .stage{position:relative;left:.4px;display:grid;place-items:center;width:132px;height:132px;margin:0 auto;border-radius:50%;background:#daf3e2}
.p-linked .spark{position:absolute;left:50%;top:50%;width:1px;height:1px;overflow:visible}
.p-linked .card h1{margin-top:28.5px;font-size:45.5px;line-height:52px;font-weight:700;letter-spacing:-.03em;color:#080d15;overflow-wrap:anywhere}
.p-linked .lede{position:relative;left:0;max-width:560px;margin:16px auto 0;font-size:22.3px;line-height:33px;letter-spacing:-.01em;color:#555e75}
.p-linked .facts{position:relative;margin-top:37.5px;border-radius:14px;background:#f8f9fb;text-align:left}
.p-linked .fact{position:relative;height:117px}
.p-linked .fact+.fact{margin-top:2px}
.p-linked .fact+.fact::before{content:"";position:absolute;left:156px;right:37px;top:-2px;height:2px;background:#eeeff3}
.p-linked .fact .t{position:absolute;left:39.5px;top:24px;display:grid;place-items:center;width:80px;height:80px;border-radius:12px;background:#f2f3f6;color:#0a0f18}
.p-linked .fact+.fact .t{top:15px;background:none}
.p-linked .fact .t .ic{width:54px;height:54px;stroke:none}
.p-linked .fact .t .gh{fill:currentColor}
.p-linked .fact .l{position:absolute;left:156px;top:31px;display:block;font-size:18.75px;line-height:26px;letter-spacing:-.03em;color:#5c667c}
.p-linked .fact .v{position:absolute;left:156px;top:61px;display:block;font-size:22px;line-height:30px;font-weight:500;letter-spacing:-.02em;color:#050609;overflow-wrap:anywhere}
.p-linked .fact+.fact .l{top:25px;font-size:18.5px}
.p-linked .fact+.fact .v{top:56px}
.p-linked .tx{display:contents}
.mcurves{display:none;position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
@media (max-width:900px){
.mcurves{display:block}
.p-linked{--nh:62px;--nl:20px;--nr:20px;--ls:.095;--bmw:calc(387 * var(--ls));--bww:calc(922 * var(--ls));--bgap:calc(89 * var(--ls));--bwy:calc(86 * var(--ls));--lx:0px;--ly:0px;--ry:0px;--nfs:13px}
.p-linked .links{display:flex;gap:22px}
.p-linked .card{margin-top:28px;padding:44px 18px 28px}
.p-linked .card,.p-linked .stage{left:0}
.p-linked .stage{width:96px;height:96px}
.p-linked .spark{transform:scale(.73)}
.p-linked .links a:first-child{margin-right:0}
.p-linked .card h1{font-size:30px;line-height:38px}
.p-linked .lede{font-size:16px;line-height:25px}
.p-linked .facts{padding:0 16px}
.p-linked .fact{display:flex;align-items:center;gap:16px;height:auto;min-height:92px}
.p-linked .fact .t,.p-linked .fact+.fact .t{position:static;width:58px;height:58px;flex:none}
.p-linked .fact .t .ic{width:34px;height:34px}
.p-linked .tx{display:block;min-width:0}
.p-linked .fact .l,.p-linked .fact .v,.p-linked .fact+.fact .l,.p-linked .fact+.fact .v{position:static}
.p-linked .fact .l,.p-linked .fact+.fact .l{font-size:14.5px;line-height:20px}
.p-linked .fact .v{font-size:17px;line-height:24px}
.p-linked .fact+.fact .t{background:#f2f3f6}
.p-linked .fact+.fact::before{left:74px;right:0}
.p-linked .links{display:none}
}
`;

const MCURVES =
	`<svg class="mcurves" viewBox="0 0 512 768" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">` +
	`<path class="cv" d="M0 261C24 270 38 292 43 311S56 335 63 347"/><circle class="dt" cx="43" cy="311" r="5.5"/>` +
	`<path class="cv" d="M512 108C480 125 465 155 458 180S450 195 449 200"/><circle class="dt" cx="458" cy="180" r="5.5"/>` +
	`<path class="cv" d="M450 570C470 585 478 600 483 608S500 630 512 641"/><circle class="dt" cx="483" cy="608" r="5.5"/></svg>`;

const LINKED_CURVES =
	`<g transform="translate(0 .17)"><path class="cv" d="${CURVE_LEFT}"/><circle class="dt" cx="115.82" cy="223.54" r="6.6"/>` +
	`<path class="cv" d="${CURVE_RIGHT}"/><circle class="dt" cx="862.86" cy="373.23" r="6.6"/></g>`;

/** The end of /hookci me: says which GitHub account the Slack user is now linked to. */
export async function linkedPage(login: string, slackUserId: string, cookies: string[]) {
	const sparks = SPARK_PATHS.map(([colour, d]) => `<path fill="${colour}" d="${d}"/>`).join("");
	const fact = (tile: string, label: string, value: string) =>
		`<div class="fact"><span class="t">${tile}</span><div class="tx"><span class="l">${e(label)}</span><span class="v">${e(value)}</span></div></div>`;
	const body =
		`${siteNav("")}<main class="card"><div class="stage"><svg class="spark" aria-hidden="true" focusable="false">${sparks}<path fill="#06b354" d="${TICK_D}"/></svg></div>` +
		`<h1>${e(T.doneTitle(login))}</h1><p class="lede">${e(T.doneBody)}</p>` +
		`<div class="facts">${fact(icon("github", "gh"), T.githubAccount, login)}${fact(icon("slack"), T.slackUserShort, slackUserId)}</div></main>${MCURVES}`;
	return shellResponse(
		{ title: T.doneTitle(login), bodyClass: "p-linked", css: CSS, body, curves: LINKED_CURVES, icons: FLOW_ICONS },
		{ cookies },
	);
}
