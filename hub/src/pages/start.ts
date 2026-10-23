import { S } from "../strings";
import { escapeHtml } from "./layout";
import { blob, legalFooter, shellResponse, siteNav } from "./shell";
import { ARROW, BOLT, CHART, GH_CTA, GH_TILE, SHIELD, TERMINAL, USERS } from "./start-art";

// GET /start: the first step of onboarding, a short explanation and the Install on GitHub button.

const T = S.flow.install;
const FEATURE_ART: Record<string, string> = { bolt: BOLT, chart: CHART, users: USERS };
const e = escapeHtml;

const CSS = `
.p-start .bg{background:${blob(318, 314, "44px 580px", 0.331)},${blob(345, 267, "1512px 343px", 0.371)},${blob(378, 202, "1700px 136px", 0.195)}}
.p-start{will-change:opacity}
.p-start .cv{stroke-width:.87}
.p-start .cv.fl{stroke:url(#fl)}
.p-start .cv.fr{stroke:url(#fr)}
.p-start{--nh:93px;--ls:.134;--bwy:10;--ly:0px;--ry:1px;--nfs:16px;--ph:46px;--pw:16px;--ink:#0e141f;--orange:#fd6d21;background:#fcfcfc}
.p-start .nav{border-bottom:1px solid #eceef0}
.p-start .links{gap:48.2px;margin-right:50.85px}
.p-start .links a{position:relative;top:.5px;color:#576275;font-size:16px;font-weight:400;letter-spacing:-.01em}
.p-start .pill{padding:0 19.34px;gap:0;border-width:2px;border-radius:12px;border-color:#e2e4e9;background:#fcfbfc;font-size:16px;font-weight:500;letter-spacing:-.03em;box-shadow:none}
.stage{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;padding:44px 24px 0;text-align:center}
.stage>*{position:relative}
.art{position:absolute;inset:0;width:100%;height:100%;fill:currentColor}
.badge{left:2.5px;display:inline-flex;align-items:center;justify-content:center;width:141px;height:40px;border-radius:999px;background:#fef1ea;color:#fd5009;font-size:15.25px;font-weight:600;letter-spacing:-.008em;padding-top:2px;text-transform:uppercase}
.stage h1{left:2.3px;margin-top:19px;font-size:80.75px;line-height:80px;font-weight:700;letter-spacing:-.03em;color:var(--ink)}
.stage h1 b{color:var(--orange);font-weight:650}
.lede{left:2.4px;max-width:580px;margin-top:9px;font-size:22.25px;line-height:33px;letter-spacing:-.0166em;color:#596276}
.steps{left:1px;width:586px;max-width:100%;margin-top:49px;list-style:none;text-align:left}
.steps li{position:relative;display:flex;align-items:flex-start;min-height:83px}
.steps li:first-child{height:84px}
.steps li+li{height:83px;margin-top:46px}
.steps li:first-child::before{content:"";position:absolute;left:32px;top:72px;width:3px;height:53px;background:linear-gradient(90deg,rgba(254,106,32,.39) 33.3%,#fe6a20 33.3% 66.6%,rgba(254,106,32,.16) 66.6%);-webkit-mask-image:linear-gradient(#0000,#000 15%,#000 79%,#0000 98%);mask-image:linear-gradient(#0000,#000 15%,#000 79%,#0000 98%)}
.num{display:grid;place-items:center;flex:none;width:66px;height:66px;border-radius:50%;background:#feefe9;color:#fd6317;font-size:33px;font-weight:600;letter-spacing:0}
.steps .stile{position:relative;flex:none;width:69px;height:69px;margin:3px 0 0 43px;border-radius:12px;background:#f3f4f5;color:#0a0e17}
.steps li+li .stile{margin-top:2px}
.steps .txt{margin-left:31px}
.steps li+li .txt{margin-top:-1.5px}
.steps li+li h2{font-size:21.7px}
.steps li+li .num{padding-bottom:1px}
.steps li:first-child p{font-size:17.8px;letter-spacing:.004em}
.steps li+li p{position:relative;left:1px;font-size:17.6px;line-height:25.8px;margin-top:4.2px}
.steps li:first-child p{margin-top:3.6px;position:relative;left:0;font-size:18px;letter-spacing:.004em}
.steps h2{font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.03em;color:var(--ink)}
.steps p{margin-top:3px;font-size:17.75px;line-height:26.5px;font-weight:300;letter-spacing:0;color:#5b6478;white-space:pre}
.stage .cta{left:.5px;display:block;width:533px;height:69px;margin-top:42px;border-radius:10px;background:#11161e;color:#fafafa;font-size:21px;font-weight:450;letter-spacing:-.01em}
.cta span{position:absolute;left:182.7px;top:0;line-height:70px}
.cta .art{inset:auto;color:#fff}
.cta .ghCta{left:123px;top:13px;width:45px;height:43px}
.cta .arrow{left:377px;top:22px;width:29px;height:26px}
.secure{left:.7px;display:flex;align-items:center;justify-content:center;height:34px;margin-top:22px;font-size:15.5px;line-height:24px;font-weight:350;letter-spacing:0;color:#4f576a}
.secure span{position:relative;top:1px}
.secure .art{position:static;flex:none;width:31px;height:34px;margin-right:10.9px;color:#566076}
.feats{position:relative;z-index:2;height:132px;margin-top:34px;padding-top:32px;border-top:1px solid #eeecef;border-bottom:1px solid #e4e7eb}
.feats ul{display:grid;grid-template-columns:457px 437px 1fr;align-items:start;width:min(var(--app-w),100%);margin:0 auto;list-style:none}
.feats li{position:relative;display:flex;align-items:center;gap:34.5px;height:60px}
.feats li:nth-child(1){padding-left:33px}
.feats li:nth-child(n+2){padding-left:49px}
.feats li:nth-child(2){gap:33.5px}
.feats li:nth-child(n+2)::before{content:"";position:absolute;left:0;top:2px;width:1px;height:57.5px;background:#dfe1e8}
.feats .ftile{position:relative;flex:none;width:60px;height:60px;border-radius:14px;background:#fef2ee;color:#fd5f12}
.feats li div{padding-top:6px;align-self:flex-start}
.feats strong{display:block;font-size:18px;line-height:24px;font-weight:700;letter-spacing:-.0425em;color:var(--ink)}
.feats span.d{display:block;margin-top:3px;font-size:15.75px;line-height:24px;font-weight:300;letter-spacing:-.02em;color:#5f6a7e}
.feats li:nth-child(1) .d{letter-spacing:-.0137em}
.feats li:nth-child(2) .d{position:relative;left:1px;font-size:15.5px;letter-spacing:-.02em}
.feats li:nth-child(3) .d{letter-spacing:-.0105em}
.p-start .foot{position:relative;z-index:2;margin-top:27px;padding-bottom:35px;--ffs:14.25px;--fp:31px}
.p-start .foot a{color:#5c6578;letter-spacing:-.01em}
.p-start .foot a+a{position:relative;border-left:0}
.p-start .foot a+a::before{content:"";position:absolute;left:0;top:1px;width:1px;height:15px;background:#d3d6db}
@media (max-width:900px){
.p-start{--nh:68px;--ls:.1;--ph:40px;--pw:14.5px}
.stage{padding-top:32px}
.stage>*{left:0}
.stage h1{font-size:42px;line-height:50px}
.lede{font-size:17px;line-height:26px}
.steps .stile{position:relative;margin:0 0 0 14px;width:56px;height:56px}
.steps li:first-child,.steps li+li{height:auto;min-height:0}
.steps li+li{margin-top:28px}
.steps li+li .stile{margin-top:0}
.steps .txt,.steps li+li .txt{flex:1;min-width:0;margin:0 0 0 14px}
.steps h2,.steps li+li h2{font-size:18px;line-height:24px}
.steps p,.steps li+li p,.steps li:first-child p{left:0;margin-top:4px;font-size:15px;line-height:22px;letter-spacing:0;white-space:normal}
.num,.steps li+li .num{width:48px;height:48px;padding:0;font-size:22px}
.steps li:first-child::before{left:23px;top:50px;height:60px;bottom:auto}
.stage .cta{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;max-width:342px;height:60px;margin-top:32px;font-size:18px}
.cta span{position:static;line-height:1}
.cta .art{position:static;flex:none}
.cta .ghCta{width:32px;height:31px}
.cta .arrow{width:21px;height:19px}
.secure{height:auto;text-align:left;align-items:flex-start}
.secure span{top:0}
.secure .art{margin-top:2px}
.feats{height:auto;margin-top:32px;padding:0}
.feats ul{display:block;width:100%;padding:12px 24px}
.feats li,.feats li:nth-child(n){height:auto;padding:16px 0;gap:16px}
.feats li:nth-child(n+2)::before{left:0;right:0;top:0;width:auto;height:1px}
.feats li:nth-child(n) .d{left:0;font-size:15px;letter-spacing:0}
.feats strong{letter-spacing:-.02em}
}
@media (min-width:901px) and (max-width:1300px){
.steps p,.steps li:first-child p,.steps li+li p{white-space:normal}
.feats{height:auto;padding:28px 0}
.feats ul{grid-template-columns:repeat(3,minmax(0,1fr));width:100%;padding:0 24px}
.feats li,.feats li:nth-child(n){height:auto;gap:16px;padding:0 0 0 24px;align-items:flex-start}
.feats li:nth-child(1){padding-left:0}
.feats li:nth-child(n+2)::before{top:0;height:100%}
.feats li:nth-child(n) .d{left:0}
}
@media (max-width:640px){
.p-start .navr{min-width:0;margin-left:12px}
.p-start .pill{padding:0 12px;font-size:14px;line-height:1.2}
}
`;

/** The install landing page; installUrl is the GitHub App install link carrying the OAuth state. */
export async function startPage(installUrl: string, stateCookie: string) {
	const signIn = `<a class="pill" href="/app">${e(S.site.navSignIn)}</a>`;
	const steps = [
		{ glyph: GH_TILE, title: T.stepOneTitle, body: T.stepOneBody },
		{ glyph: TERMINAL, title: T.stepTwoTitle, body: T.stepTwoBody },
	];
	const list = steps
		.map(
			(s, i) =>
				`<li><span class="num">${i + 1}</span><span class="stile">${s.glyph}</span><div class="txt"><h2>${e(s.title)}</h2><p>${e(s.body)}</p></div></li>`,
		)
		.join("");
	const feats = T.features
		.map((f) => `<li><span class="ftile">${FEATURE_ART[f.icon]}</span><div><strong>${e(f.title)}</strong><span class="d">${e(f.body)}</span></div></li>`)
		.join("");
	const body =
		`${siteNav(signIn)}<main class="stage"><span class="badge">${e(T.badge)}</span>` +
		`<h1>${e(T.title)} <b>${e(T.titleBrand)}</b></h1><p class="lede">${e(T.subtitle)}</p>` +
		`<ol class="steps" aria-label="${e(T.stepsLabel)}">${list}</ol>` +
		`<a class="btn cta" href="${e(installUrl)}">${GH_CTA}<span>${e(T.button)}</span>${ARROW}</a>` +
		`<p class="secure">${SHIELD}<span>${e(T.secure)}</span></p></main>` +
		`<section class="feats" aria-label="${e(T.featuresLabel)}"><ul>${feats}</ul></section>${legalFooter()}`;
	return shellResponse({ title: S.pages.startTitle, bodyClass: "p-start", css: CSS, body, curves: CURVES }, { cookies: [stateCookie] });
}

const CURVES =
	`<defs><linearGradient id="fl" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="303.3" y2="0"><stop offset="0" stop-color="#fe6a20" stop-opacity=".72"/><stop offset=".09" stop-color="#fe6a20" stop-opacity=".95"/><stop offset=".66" stop-color="#fe6a20"/><stop offset=".75" stop-color="#fe6a20" stop-opacity=".72"/><stop offset=".835" stop-color="#fe6a20" stop-opacity=".46"/><stop offset=".92" stop-color="#fe6a20" stop-opacity=".28"/><stop offset="1" stop-color="#fe6a20" stop-opacity="0"/></linearGradient>` +
	`<linearGradient id="fr" gradientUnits="userSpaceOnUse" x1="713.3" y1="0" x2="1023.3" y2="0"><stop offset="0" stop-color="#fe6a20" stop-opacity="0"/><stop offset=".14" stop-color="#fe6a20" stop-opacity=".33"/><stop offset=".4" stop-color="#fe6a20" stop-opacity=".55"/><stop offset=".7" stop-color="#fe6a20" stop-opacity=".85"/><stop offset=".88" stop-color="#fe6a20"/><stop offset="1" stop-color="#fe6a20" stop-opacity=".92"/></linearGradient></defs>` +
	`<path class="cv fl" d="M0 238.75C3.33 238.49 13.33 237.44 20 237.18C26.67 236.92 33.33 236.85 40 237.18C46.67 237.51 53.33 238.13 60 239.16C66.67 240.19 73.33 241.49 80 243.37C86.67 245.24 93.33 247.5 100 250.42C106.67 253.33 113.33 256.71 120 260.87C126.67 265.02 133.33 269.8 140 275.33C146.67 280.86 153.33 287.37 160 294.05C166.67 300.74 173.33 308.52 180 315.46C186.67 322.4 193.33 329.57 200 335.68C206.67 341.79 213.33 347.32 220 352.09C226.67 356.86 233.33 360.94 240 364.31C246.67 367.67 253.33 370.22 260 372.26C266.67 374.29 273.33 375.34 280 376.53C286.67 377.73 296.13 378.87 300 379.44C303.87 380 302.8 379.83 303.33 379.91"/>` +
	`<circle class="dt" cx="162.71" cy="296.93" r="5.5"/>` +
	`<path class="cv fr" d="M713.33 321.14C716.67 320.51 726.67 319.15 733.33 317.35C740 315.55 746.67 313.41 753.33 310.31C760 307.22 766.67 303.24 773.33 298.79C780 294.34 786.67 289.13 793.33 283.6C800 278.08 806.67 271.95 813.33 265.65C820 259.34 826.67 252.51 833.33 245.79C840 239.07 846.67 231.89 853.33 225.33C860 218.77 866.67 212.33 873.33 206.44C880 200.55 886.67 195.02 893.33 189.97C900 184.93 906.67 180.18 913.33 176.19C920 172.19 926.67 169.21 933.33 165.99C940 162.78 946.67 159.58 953.33 156.9C960 154.22 966.67 152.49 973.33 149.91C980 147.33 986.67 143.5 993.33 141.41C1000 139.32 1008.33 138.09 1013.33 137.38C1018.33 136.67 1021.67 137.22 1023.33 137.19"/>` +
	`<circle class="dt" cx="816.7" cy="262.89" r="5.39"/>`;
