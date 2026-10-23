import { S } from "../strings";
import { ACCOUNT_CURVES } from "./account-art";
import { ACCOUNT_ICONS } from "./account-icons";
import { logoStack as stack } from "./brand";
import { escapeHtml, type PageInit } from "./layout";
import { blob, icon, legalFooter as footer, shellResponse, siteNav } from "./shell";

// Server-rendered pages for optional email and password accounts. Self-contained: one inline
// stylesheet, at most one inline script (the password eye toggle), both pinned by SHA-256 in the CSP.

const D = S.account;
const e = escapeHtml;

export interface FormState {
	csrf: string;
	googleEnabled: boolean;
	/** Final user text; escaped here. */
	error?: string;
	email?: string;
}

type Variant = "login" | "reg" | "center";

const CSS = `
.p-login,.p-reg,.p-center{will-change:opacity}
.p-login .cv,.p-reg .cv,.p-center .cv{stroke-width:.6}
.p-login .dt,.p-reg .dt,.p-center .dt{fill:#fd6210}
.p-login .bg{background:${blob(274, 331, "49px 922px", 0.28)},${blob(245, 317, "1487px 292px", 0.25)},${blob(188, 174, "1494px 967px", 0.19)}}
.p-reg .bg{background:${blob(290, 345, "52px 884px", 0.33)},${blob(208, 266, "1509px 355px", 0.25)},${blob(200, 190, "1505px 964px", 0.33)}}
.p-center .bg{background:${blob(283, 342, "69px 744px", 0.38)},${blob(334, 357, "1562px 339px", 0.39)},${blob(317, 254, "1599px 1023px", 0.42)}}
.p-login{--nh:81px;--ls:.139;--ly:4px;--ry:0px;--lk:36px;--nfs:15px;--ph:42px;--pw:14.5px;
--cw:531px;--cr:14px;--px:66px;--pt:32px;--pb:26px;--smw:99;--sww:128.2;--sgp:13.8;--swx:1.5;--g3:13px;--ts:18px;--tl:24px;--g4:26px;--sg:13.2px;--sh:53px;--si:25px;--sic:32px;--sfs:18px;
--g5:20.4px;--dsz:14px;--fg:19.8px;--lfs:16px;--lg:6.3px;--ih:49px;--ip:45px;--ifs:15.25px;--bh:51px;--bfs:17.5px;--g6:17px;--g7:15.4px;--afs:15.75px;--br:7.5px;--ffs:14.5px;--fp:26px;--g10:21px;
--ft:47px;--hx:100px}
.p-reg{--nh:87px;--ls:.136;--ly:0px;--ry:-1.5px;--lk:36px;--nfs:14.75px;--ph:44px;--pw:14.5px;
--cw:543px;--cr:20px;--px:47.5px;--pt:34px;--pb:30px;--smw:83.26;--sww:124.29;--sgp:9.44;--swx:.2;--g2:11.1px;--th:31px;--g3:9.2px;--ts:17.25px;--tl:22px;--g4:25px;--sg:12.4px;--sh:54.5px;--si:22px;--sic:32px;--sfs:17px;
--g5:27.7px;--dsz:14px;--fg:21.1px;--lfs:16px;--lg:6.7px;--ih:48px;--ip:46px;--ifs:15.75px;--bh:53px;--bfs:17.5px;--g6:20.7px;--g7:20px;--afs:16px;--br:10px;--ffs:14.25px;--fp:29px;--g10:26px;
--ft:66px;--hx:106px}
.p-center{--nh:94px;--ls:.1432;--ly:0px;--ry:5px;--lk:42px;--nfs:16.5px;--ph:48px;--pw:17px;
--cw:573px;--cr:22px;--px:44.5px;--pt:37.7px;--pb:35px;--smw:97.93;--sww:137.31;--sgp:14.5;--g2:24.3px;--th:32.5px;--g3:12px;--ts:20px;--tl:27px;--g4:34px;--sg:15px;--sh:58px;--si:26px;--sic:32px;--sfs:17px;
--g5:28px;--dsz:14px;--fg:36px;--lfs:17px;--lg:12px;--ih:58px;--ip:58px;--ifs:19px;--bh:60px;--bfs:19.5px;--g6:22.8px;--g7:22px;--afs:16.5px;--br:12px;--ffs:16px;--fp:29px;--g10:28px;
--ft:66px;--hx:106px}
.p-reg .nav,.p-center .nav{border-bottom:1px solid #f0f1f3;background:#fbfbfb}
.stage{position:relative;z-index:2;max-width:var(--app-w);margin:0 auto}
.s-login{display:grid;grid-template-columns:1fr var(--cw) 1fr;padding:5px 0 29px}
.s-reg{display:grid;grid-template-columns:1fr var(--cw) 306px;padding:35px 0 51px}
.s-center{display:flex;justify-content:center;padding:53px 0 56px}
.hero{padding-left:var(--hx);padding-right:20px}
.s-login .hero{grid-column:1;grid-row:1;padding-top:132px;align-self:start}
.s-login .card{grid-column:2;grid-row:1}
.s-login .side{grid-column:3;grid-row:1;align-self:start;padding:352px 0 0 98px}
.s-reg .hero{grid-column:1;grid-row:1;padding-top:96px;align-self:start}
.s-reg .card{grid-column:2;grid-row:1}
.rule{display:block;width:28px;height:4px;border-radius:2px;background:#fd6810}
.s-reg .rule{width:34px}
.hero h2{margin-top:27px;font-size:42.3px;line-height:48px;font-weight:700;letter-spacing:-.02em;color:#0a0e18}
.s-reg .hero h2{margin-top:28px;font-size:53px;line-height:57px;letter-spacing:-.005em}
.hero .lede{margin-top:19px;font-size:20.5px;line-height:28.5px;color:var(--muted);max-width:330px}
.s-reg .hero .lede{margin-top:20px;font-size:23.6px;line-height:32px;max-width:395px}
.feats{list-style:none;display:grid;gap:42px;margin-top:107px}
.s-reg .feats{gap:26px;margin-top:141px}
.feats li,.rf{display:flex;align-items:center;gap:26px}
.ftile{display:grid;place-items:center;flex:none;width:var(--ft);height:var(--ft);border-radius:calc(var(--ft) * .28);background:#fff1ea;color:var(--orange);box-shadow:0 4px 14px rgba(255,106,44,.07)}
.ftile .ic{width:calc(var(--ft) * .5);height:calc(var(--ft) * .5)}
.s-reg .feats li{gap:29px}
.ft strong,.rt strong{display:block;font-size:17.5px;line-height:23px;font-weight:500;color:var(--ink)}
.ft span,.rt p{display:block;font-size:17.5px;line-height:23px;color:#3b4350}
.s-reg .ft strong{font-size:19px}
.s-reg .ft span{font-size:18.5px;color:var(--muted)}
.rfs{list-style:none;display:grid;gap:50px;padding-top:6px}
.rf{align-items:flex-start;gap:26px}
.rf .ftile{width:50px;height:50px}
.rt strong{font-weight:600;line-height:23px;max-width:240px;font-size:17px}
.rt p{margin-top:6px;max-width:222px;font-size:14.5px;line-height:21px;color:var(--muted)}
.p-login{--ink:#01040b;--orange:#fe4c03}
.s-login .ftile .ic{width:40px;height:40px}
.s-login .hero h2{margin-top:19px;font-size:40px;line-height:47.9px;font-weight:600;letter-spacing:-.02em;color:#00030a}
.s-login .hero h2 span{display:block}
.s-login .hero h2 span:nth-child(1){letter-spacing:-.018em}
.s-login .hero h2 span:nth-child(2){letter-spacing:-.0075em}
.s-login .hero h2 span:nth-child(3){letter-spacing:-.026em}
.s-login .hero .lede{margin-top:12.3px;font-size:20px;line-height:28.5px;font-weight:350;letter-spacing:-.018em;color:#4a5365}
.s-login .feats{gap:44.3px;margin-top:117px}
.s-login .ft strong{font-size:17.5px;letter-spacing:-.03em}
.s-login .ft span{font-size:17.5px;font-weight:340;letter-spacing:-.04em;color:#0b1020}
.s-login .rfs{gap:40px;padding-top:9px}
.s-login .rf{gap:27px}
.s-login .rf .ftile{width:48px;height:48px}
.s-login .rf:nth-child(3){margin-top:5px}
.s-login .rt strong{font-size:17.25px;font-weight:600;line-height:22px;letter-spacing:-.031em}
.s-login .rt p{margin-top:5.4px;max-width:236px;font-size:16px;line-height:21.8px;font-weight:350;letter-spacing:-.025em;color:#4f5968}
.s-login .rf:nth-child(1) p{max-width:180px;letter-spacing:-.038em}
.s-login .rf:nth-child(2) strong{letter-spacing:-.0354em}
.s-login .rf:nth-child(3) p{letter-spacing:-.032em}
.s-login .feats li:nth-child(1) .ft span{letter-spacing:-.0167em}
.s-login .feats li:nth-child(2) .ft span{letter-spacing:-.0333em}
.s-login .feats li:nth-child(3) .ft strong{letter-spacing:-.0374em}
.p-login #password::placeholder{letter-spacing:-.021em}
.p-login .links{margin-right:44px}
.p-login .links a:nth-child(2){transform:translateX(1.8px)}
.p-login .links a{color:#475266;font-weight:500;font-size:14.5px;letter-spacing:-.03em}
.p-login .pill{padding:0 16px 0 16.5px;gap:12.3px;letter-spacing:-.035em}
.p-login .pill span{transform:translateY(2px)}
.p-login .sub{padding-left:4.6px;letter-spacing:-.04em;color:#4f596b}
.p-login .sbtn{border-color:#f1f2f5;border-top-color:#dfe2e8;border-bottom-color:#dee2e9;font-size:18px;letter-spacing:-.04em}
.p-login .sbtn span{flex:none;margin-left:61.5px;padding:0;text-align:left}
.p-login .sbtn:nth-child(2) span{letter-spacing:-.034em}
.p-login .sbtn .lg{transform:scale(1.11)}
.p-login .sbtn:nth-child(2) .lg{transform:scale(1.08)}
.p-login .div{gap:24px;color:#677182;letter-spacing:.19em}
.p-login .fld+.fld{margin-top:22.4px}
.p-login .div::before,.p-login .div::after{height:2px;background:linear-gradient(#e2e4e8 50%,#e9ebee 50%)}
.p-login .lbl{letter-spacing:-.04em}
.p-login .forgot{position:relative;top:-2.8px;left:1.7px;font-weight:400;font-size:15px;letter-spacing:-.05em}
.p-login input{border-color:#eef0f2;border-bottom-color:#dfe2e7;letter-spacing:-.015em}
.p-login input::placeholder{color:#4f596a;font-weight:350}
.p-login .btn{border-radius:22px;background:#0c121a;letter-spacing:-.03em}
.p-login .alt{letter-spacing:-.01em;color:#556071}
.p-login .alt a{font-weight:400}
.p-login .perm{margin:12px -1.5px 0;padding:19px 24px 17px 18px;background:#f8f9fb;border-radius:10px;gap:15px}
.p-login .in .ic{left:8.4px;width:28px;height:28px;margin-top:-13.4px;color:#6c7482}
.p-login .eye{right:4.9px;color:#606878}
.p-login .eye .ic{position:static;width:28px;height:28px;margin:0}
.p-login .eye .off{width:22px;height:22px}
.p-login .btn .ic{width:28px;height:28px;margin:0 -5px}
.p-login .pr{grid-template-columns:28px 1fr;gap:16px}
.p-login .pr .ic{width:28px;height:28px;margin:-1px 0 0 -3px;color:#01040b}
.p-login .pr strong,.p-login .pr span{font-size:13.5px;letter-spacing:-.04em}
.p-login .pr span{font-weight:350;letter-spacing:-.033em;color:#4a5466}
.p-login .pr:nth-child(1) span{letter-spacing:-.0395em}
.p-login .foot{position:relative;top:1.6px;font-size:14.5px;letter-spacing:-.03em}
.p-login .foot a+a{border-left:2px solid #d0d3d9}
.p-reg .links a{color:#4a5568;font-weight:400;font-size:15px;letter-spacing:-.015em}
.p-reg .links a:nth-child(1){transform:translate(1px,-1px)}
.p-reg .links a:nth-child(2){transform:translate(0,-1px);letter-spacing:-.03em}
.p-reg .links a:nth-child(3){transform:translate(-3px,-1px)}
.p-reg .nav{border-bottom-color:#f1f1f3}
.p-reg .pill{padding:0 17.2px 0 16.2px;gap:7px;height:45px;border-color:#e5e7eb;background:#fcfcfc;letter-spacing:0;box-shadow:none}
.p-reg .pill span{transform:translateY(1px)}
.p-reg .pill .ic{width:31px;height:31px;margin:0 -2.8px;transform:translateY(1.5px)}
.s-reg .hero h2{margin-top:19.8px;font-size:51px;line-height:57px;font-weight:600;letter-spacing:-.015em;color:#060b14}
.s-reg .hero .lede{margin-top:16.6px;font-size:23px;line-height:32.3px;letter-spacing:-.005em;color:#4b5567}
.s-reg .ft strong{font-size:19px;font-weight:560;letter-spacing:-.03em;color:#05070c}
.s-reg .ft span{font-size:18px;letter-spacing:-.02em;color:#3f4959}
.s-reg .feats{gap:25.4px;margin-top:155.8px}
.s-reg .ft{position:relative;top:-3.1px;left:3px}
.s-reg .ft span{margin-top:4.5px}
.s-reg .feats li:nth-child(1) .ft strong{font-weight:500;letter-spacing:-.044em}
.s-reg .feats li:nth-child(2) .ft strong{font-weight:600;letter-spacing:-.018em}
.s-reg .feats li:nth-child(3) .ft strong{font-weight:600;letter-spacing:-.0075em}
.s-reg .feats li:nth-child(1) .ft span{letter-spacing:-.0295em}
.s-reg .feats li:nth-child(2) .ft span{letter-spacing:-.012em}
.s-reg .feats li:nth-child(3) .ft span{letter-spacing:0}
.p-reg .sub{letter-spacing:-.01em;color:#4c5666}
.p-reg .ttl{letter-spacing:-.02em;color:#060b14}
.p-reg .sbtn{border-color:#eceef2;letter-spacing:-.01em}
.p-reg .div{color:#555e6f;letter-spacing:-.01em}
.p-reg .lbl{letter-spacing:-.04em;color:#070a12}
.p-reg .lrow .lbl{margin-left:-2.7px;letter-spacing:-.0547em}
.p-reg input{border-color:#eef1f4;letter-spacing:-.04em}
.p-reg input::placeholder{color:#606879}
.p-reg input[type=password]{letter-spacing:-.0235em}
.p-reg .hint{margin-top:5.4px;font-size:13px;letter-spacing:-.016em;color:#535d70}
.p-reg .btn{background:#0d131b;letter-spacing:-.017em}
.p-reg .alt{letter-spacing:-.0175em;color:#50596a}
.p-reg .alt a{font-weight:400;color:#e55612}
.p-reg .foot{position:relative;top:1.2px;font-size:14.25px;letter-spacing:-.01em}
.p-reg .foot a:nth-of-type(2){position:relative;left:-3.6px}
.p-reg .foot a:nth-of-type(3){position:relative;left:-5.1px}
.p-reg .foot.rule2{margin-top:26.7px}
.card{position:relative;z-index:2;width:var(--cw);padding:var(--pt) var(--px) var(--pb);border:1px solid #eceef1;border-radius:var(--cr);background:#fff;box-shadow:0 1px 2px rgba(15,20,29,.04),0 8px 24px rgba(15,20,29,.06);text-align:center}
.ttl{margin-top:var(--g2);font-size:var(--th);line-height:1.15;font-weight:700;letter-spacing:-.015em;color:var(--ink)}
.sub{margin-top:var(--g3);font-size:var(--ts);line-height:var(--tl);color:var(--muted)}
.p-center .sub{margin-left:auto;margin-right:auto;max-width:410px;font-size:18.75px;letter-spacing:-.014em;color:#4a5468}
.p-center .ttl{font-weight:700;letter-spacing:-.03em;color:#070b15}
.p-center .lbl{font-size:18.75px;letter-spacing:-.055em;color:#07090f}
.p-center input{font-size:19.5px;letter-spacing:-.05em}
.p-center input::placeholder{color:#737b8d}
.p-center .card .btn{font-size:19.75px;letter-spacing:-.03em}
.p-center .note strong{font-size:17px;font-weight:600;letter-spacing:-.03em;color:#07080c}
.p-center .note p{font-size:15px;letter-spacing:-.019em;color:#555e6e}
.p-center .note{margin-top:17.8px}
.p-center .note p{margin-top:2.7px}
.p-center .back{margin-top:20.8px}
.p-center .back a{gap:0;font-size:17px;letter-spacing:-.03em;color:#434c5d}
.p-center .foot{margin-top:25.5px;font-size:16.5px;letter-spacing:-.045em}
.p-center .links a{position:relative;top:2px;font-size:18px;font-weight:450;letter-spacing:-.02em;color:#525b6d}
.p-center .links a:nth-child(1){left:-16.4px}
.p-center .links a:nth-child(2){left:-12px}
.p-center .links a:nth-child(3){left:-7.2px}
.p-center .pill{padding:0 18px 0 22px;gap:10px;letter-spacing:-.035em;border-color:#e8ebee;background:#fbfcfc;box-shadow:none}
.p-center .pill span{transform:translateY(3px)}
.p-center .pill .ic{width:32.3px;height:32.3px;margin:0 -3.7px;transform:translateY(1px)}
.p-center .btn{gap:12px;padding-left:18px}
.p-center .btn .ic{width:24px;height:24px}
.p-center .btn .gh{width:30px;height:30px;margin:0 -3px}
.p-center .back .ic{width:22px;height:22px;transform:translateY(4px)}
.p-center .note .tile{position:relative;left:-1px;top:-1.3px;width:58px;height:59px}
.p-center .note .tile .ic{margin-top:-2.4px}
.p-center .fld .in{margin-top:11.2px}
.err{margin-top:18px;padding:11px 14px;border:1px solid #ffd3bf;border-radius:10px;background:#fff4ee;color:#a8420f;font-size:14.5px;line-height:1.4;text-align:left}
.sso{display:grid;gap:var(--sg);margin-top:var(--g4)}
.sbtn{display:flex;align-items:center;height:var(--sh);padding:0 var(--si);border:1px solid #e3e6ea;border-radius:var(--br);background:#fff;color:var(--ink);font-size:var(--sfs);font-weight:500;text-decoration:none;box-shadow:0 1px 2px rgba(15,20,29,.04),0 3px 10px rgba(15,20,29,.04)}
.sbtn:hover{background:#fcfcfd}
.sbtn .lg{width:var(--sic);height:var(--sic);stroke:none}
.sbtn span{flex:1;padding-right:var(--sic);text-align:center}
.p-reg .sbtn span{padding:0 0 0 53px;text-align:left}
.p-reg .sbtn .lg{margin-left:-2px}
.p-reg .sbtn[href*="google"] .lg{width:34.5px;height:34.5px;margin-right:-2.5px;transform:translateX(.8px)}
.p-reg .sbtn:not([href*="google"]) .lg{width:44px;height:44px;margin:0 -8px 0 -6px;transform:translateY(-1px)}
.p-reg .sbtn .arr{width:24px;height:24px;margin-right:-3px}
.p-reg .btn{padding-left:11px}
.p-reg .btn .ic{width:24px;height:24px}
.s-reg .ftile .ic{width:40px;height:40px}
.s-reg .ftile{transform:translate(4.5px,-4px)}
.s-reg .feats li:nth-child(2) .ftile{transform:translate(4.5px,-3.5px)}
.s-reg .feats li:nth-child(3) .ftile{transform:translate(4.5px,-5.5px)}
.sbtn .arr{width:20px;height:20px;color:#3b4350}
.div{display:flex;align-items:center;gap:16px;margin-top:var(--g5);color:#8b92a0;font-size:var(--dsz);line-height:20px}
.div::before,.div::after{content:"";flex:1;height:1px;background:#e8eaed}
.fld{margin-top:var(--fg);text-align:left}
.lrow{display:flex;align-items:baseline;justify-content:space-between}
.lbl{display:block;font-size:var(--lfs);line-height:20px;font-weight:500;color:var(--ink)}
.forgot{color:var(--orange);font-size:14.5px;font-weight:500;text-decoration:none}
.in{position:relative;margin-top:var(--lg)}
.in .ic{position:absolute;left:15px;top:50%;width:20px;height:20px;margin-top:-10px;color:#6b7280;pointer-events:none}
.p-center .in .ic{left:18px;width:24px;height:24px;margin-top:-12px}
input{display:block;width:100%;height:var(--ih);padding:0 14px 0 var(--ip);border:1px solid #e4e7eb;border-radius:var(--br);background:#fff;color:var(--ink);font-family:inherit;font-size:var(--ifs);letter-spacing:inherit;outline:0}
input::placeholder{color:#9ba1ad}
input:focus{border-color:var(--orange-line);box-shadow:0 0 0 3px rgba(255,106,44,.14)}
.eye{position:absolute;top:50%;right:8px;display:grid;place-items:center;width:36px;height:36px;margin-top:-18px;border:0;border-radius:8px;background:none;color:#6b7280;cursor:pointer}
.eye .ic{position:static;width:20px;height:20px;margin:0}
.eye .off{display:none}
.eye[aria-pressed="true"] .on{display:none}
.eye[aria-pressed="true"] .off{display:block}
.eye:hover{color:var(--ink)}
.hint{margin-top:9px;font-size:13.3px;line-height:18px;color:var(--muted);text-align:left}
.alt{margin-top:var(--g7);font-size:var(--afs);line-height:22px;color:var(--muted)}
.alt a{color:var(--orange);font-weight:500;text-decoration:none}
.perm{display:grid;gap:14px;margin-top:16px;padding:15px 20px 18px;border-radius:12px;background:linear-gradient(#f6f7f8,#fcfcfd);text-align:left}
.pr{display:grid;grid-template-columns:22px 1fr;gap:20px}
.pr .ic{width:22px;height:22px;margin-top:1px;color:#2b313c}
.pr strong{display:block;font-size:13.4px;line-height:20px;font-weight:500;color:var(--ink)}
.pr span{display:block;font-size:13.2px;line-height:19px;color:var(--muted)}
.note{display:flex;align-items:center;gap:25px;margin-top:17px;padding:20px;border-radius:14px;background:#fafbfc;text-align:left}
.note .tile{width:58px;height:58px;border-radius:15px}
.note strong{display:block;font-size:var(--afs);line-height:24px;font-weight:500;color:var(--ink)}
.note p{font-size:15.4px;line-height:24px;color:var(--muted);max-width:312px}
.tile.lg{width:84px;height:84px;margin:var(--g2) auto 0;border-radius:24px}
.tile.lg .ic{width:40px;height:40px}
.tile.gh .ic{stroke:none;fill:currentColor}
.tile.gh .ic path,.btn .gh path{fill:currentColor}
.back{display:flex;justify-content:center;margin-top:22px;padding:27px 0 32px;border-top:1px solid #eceef1;border-bottom:1px solid #eceef1}
.back a{display:inline-flex;align-items:center;gap:9px;color:#4b5563;font-size:var(--afs);text-decoration:underline;text-underline-offset:3px}
.back .ic{width:18px;height:18px}
.back.one{border-bottom:0}
.foot.rule2{margin-top:30px;padding-top:27px;border-top:1px solid #e4e6ea}
.msg{margin:20px auto 0;max-width:410px;font-size:var(--ts);line-height:var(--tl);color:var(--muted)}
.msg+.msg{margin-top:12px;font-size:var(--ffs)}
.p-center .card .btn{margin-top:22px}
.kv{margin-top:24px;border:1px solid #eceef1;border-radius:14px;text-align:left}
.kv div{display:flex;justify-content:space-between;gap:16px;padding:14px 18px;font-size:15px;line-height:22px}
.kv div+div{border-top:1px solid #eceef1}
.kv dt{color:var(--muted)}
.kv dd{color:var(--ink);font-weight:500;text-align:right;overflow-wrap:anywhere}
.p-center .card .btn.danger{background:#b4350b}
.p-center .card .btn.danger:hover{background:#962c09}
@media (min-width:901px) and (max-width:1400px){
.hero{padding-left:44px;padding-right:12px}
.s-login .side{padding-left:36px;padding-right:20px}
.s-reg{grid-template-columns:1fr var(--cw) 120px}
.rt p{max-width:190px}
}
@media (max-width:900px){
.p-login,.p-reg,.p-center{--nh:64px;--ls:.105;--ly:0px;--ry:0px;--ph:40px;--cw:100%;--cr:18px;--px:24px;--pt:28px;--pb:22px;--smw:78;--sww:101;--sgp:10;--g2:18px;--th:26px;--g3:10px;--ts:15.5px;--tl:22px;--g4:22px;--sg:12px;--sh:50px;--si:18px;--sic:26px;--sfs:15.5px;--g5:20px;--fg:18px;--ih:48px;--ip:46px;--ifs:16px;--bh:50px;--bfs:16px;--g6:20px;--g7:18px;--afs:15.5px;--ffs:14.5px;--fp:20px;--g10:20px}
.p-reg .nav,.p-center .nav{background:#fbfbfb}
.hero,.side{display:none}
.s-login,.s-reg,.s-center{display:block;padding:12px 16px 28px}
.card{margin:0 auto;max-width:480px}
.p-login .bg,.p-reg .bg,.p-center .bg{background:${blob(200, 230, "-20px 85%", 0.22)},${blob(190, 210, "105% 12%", 0.2)}}
.note .tile{width:52px;height:52px}
.note{gap:16px;padding:16px}
.back{margin-top:22px}
.tile.lg{width:72px;height:72px}
.p-center .in .ic{left:15px;width:20px;height:20px;margin-top:-10px}
.p-center .pill{padding:0;gap:0}
.p-reg .pill .ic,.p-center .pill .ic{width:30px;height:30px;margin:0;transform:none}
.p-center .sub{max-width:none;font-size:15.5px}
.p-center .lbl{font-size:15.5px;letter-spacing:0}
.p-center input{font-size:16px;letter-spacing:0}
.p-center .card .btn{font-size:16px;letter-spacing:0;padding-left:0}
.p-center .card .btn .ic{width:20px;height:20px}
.p-center .note strong{font-size:15.5px}
.p-center .note p{font-size:14px}
.p-center .back a,.p-center .foot{font-size:14.5px}
.p-center .note .tile{left:0;top:0;width:52px;height:52px}
.p-center .note .tile .ic{margin-top:0}
.p-center .back a{gap:9px}
.p-center .back .ic{transform:none}
.p-center .fld .in{margin-top:12px}
}
@media (min-width:901px) and (max-width:1100px){
.s-login .hero,.s-login .side,.rf,.rt{min-width:0}
.hero h2,.hero .lede,.rt strong,.rt p{overflow-wrap:anywhere}
}
@media (max-width:900px){
.card{overflow-wrap:anywhere}
.note>div{min-width:0}
.btn{padding-top:8px;padding-bottom:8px}
.sbtn{height:auto;min-height:var(--sh);padding-top:6px;padding-bottom:6px}
.sbtn span,.p-login .sbtn span{min-width:0}
.p-login .sbtn span{flex:1;margin-left:0;padding:0 var(--sic) 0 0;text-align:center}
.in{display:flex;align-items:center;gap:8px}
.in input{flex:1;width:auto;min-width:0}
.eye,.p-login .eye{position:static;right:auto;flex:none;width:44px;height:var(--ih);margin:0;border:1px solid #e4e7eb;border-radius:var(--br);background:#fff}
.eye .ic,.p-login .eye .ic,.p-login .eye .off{width:22px;height:22px}
.lrow{align-items:center}
.forgot,.p-login .forgot{display:inline-flex;align-items:center;min-height:44px;top:0;left:0}
.lrow+.in{margin-top:8px}
.back{padding:12px 0 16px}
.back a,.p-center .back a{min-height:44px}
.p-reg .foot a:nth-of-type(2),.p-reg .foot a:nth-of-type(3){left:0}
}
@media (max-width:640px){
.s-login,.s-reg,.s-center{padding:10px 10px 24px}
.p-login,.p-reg,.p-center{--px:16px}
.kv div{flex-direction:column;gap:2px}
.kv dd{text-align:left}
}
`;

const SCRIPT = `for(const b of document.querySelectorAll("[data-pw]")){const i=document.getElementById(b.dataset.pw);if(i){b.hidden=false;b.addEventListener("click",()=>{const show=i.type==="password";i.type=show?"text":"password";b.setAttribute("aria-pressed",String(show));b.setAttribute("aria-label",show?b.dataset.hide:b.dataset.show)})}}`;

const CURVES: Record<Variant, string> = {
	login: ACCOUNT_CURVES.login,
	reg: ACCOUNT_CURVES.reg,
	center: ACCOUNT_CURVES.center,
};

const errorBox = (error: string | undefined): string => (error ? `<div class="err" role="alert">${e(error)}</div>` : "");

const csrfInput = (csrf: string): string => `<input type="hidden" name="csrf" value="${e(csrf)}">`;

const emailField = (f: { email?: string }, label: string = D.emailLabel, placeholder: string = D.emailPlaceholder): string =>
	`<div class="fld"><label class="lbl" for="email">${e(label)}</label><div class="in">${icon("mail")}` +
	`<input id="email" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" autocorrect="off" spellcheck="false" required maxlength="254" placeholder="${e(placeholder)}" value="${e(f.email ?? "")}"></div></div>`;

function passwordField(label: string, placeholder: string, autocomplete: string, aside = ""): string {
	return `<div class="fld"><div class="lrow"><label class="lbl" for="password">${e(label)}</label>${aside}</div><div class="in">${icon("lock")}` +
		`<input id="password" name="password" type="password" autocomplete="${autocomplete}" autocapitalize="off" autocorrect="off" spellcheck="false" required placeholder="${e(placeholder)}">` +
		`<button class="eye" type="button" hidden data-pw="password" data-show="${e(D.showPassword)}" data-hide="${e(D.hidePassword)}" aria-label="${e(D.showPassword)}" aria-pressed="false">${icon("eye", "on")}${icon("eye-off", "off")}</button></div></div>`;
}

const submitButton = (label: string): string => `<button class="btn" type="submit">${e(label)}${icon("arrow")}</button>`;

const linkButton = (href: string, label: string): string => `<a class="btn" href="${e(href)}">${e(label)}${icon("arrow")}</a>`;

function ssoButton(href: string, glyph: "google" | "github", label: string, arrow: boolean): string {
	return `<a class="sbtn" href="${href}">${icon(glyph, "lg")}<span>${e(label)}</span>${arrow ? icon("arrow", "arr") : ""}</a>`;
}

function ssoBlock(f: FormState, arrow: boolean): string {
	const google = f.googleEnabled ? ssoButton("/account/google/start", "google", D.continueGoogle, arrow) : "";
	return `<div class="sso">${google}${ssoButton("/app/login", "github", D.continueGithub, arrow)}</div>`;
}

const backLink = (): string => `<div class="back"><a href="/account/login">${icon("back")}${e(D.forgot.back)}</a></div>`;

function respond(title: string, variant: Variant, inner: string, withScript: boolean, init: PageInit = {}): Promise<Response> {
	return shellResponse(
		{
			title,
			bodyClass: `p-${variant}`,
			css: CSS,
			body: `${siteNav()}<main class="stage s-${variant}">${inner}</main>`,
			curves: CURVES[variant],
			icons: ACCOUNT_ICONS[variant],
			script: withScript ? SCRIPT : undefined,
		},
		init,
	);
}

function features(items: ReadonlyArray<{ icon: string; title: string; body: string }>, prefix = ""): string {
	return `<ul class="feats">${items
		.map((it) => `<li><span class="ftile">${icon(prefix + it.icon)}</span><span class="ft"><strong>${e(it.title)}</strong><span>${e(it.body)}</span></span></li>`)
		.join("")}</ul>`;
}

export function loginPage(f: FormState, init: PageInit = {}): Promise<Response> {
	const L = D.login;
	const card =
		`<section class="card"><h1 class="sr">${e(L.title)}</h1>${stack()}<p class="sub">${e(L.subtitle)}</p>${errorBox(f.error)}` +
		`${ssoBlock(f, false)}<div class="div">${e(D.dividerOr)}</div>` +
		`<form method="post" action="/account/login">${csrfInput(f.csrf)}${emailField(f)}` +
		`${passwordField(D.passwordLabel, L.passwordPlaceholder, "current-password", `<a class="forgot" href="/account/forgot-password">${e(L.forgot)}</a>`)}` +
		`${submitButton(L.submit)}</form>` +
		`<p class="alt">${e(L.noAccount)} <a href="/account/register">${e(L.signUp)}</a></p>` +
		`<div class="perm"><div class="pr">${icon("book")}<div><strong>${e(L.permissionHeading)}</strong><span>${e(L.permissionBody)}</span></div></div>` +
		`<div class="pr">${icon("shield")}<div><strong>${e(L.privacyHeading)}</strong><span>${e(L.privacyBody)}</span></div></div></div>` +
		`${footer()}</section>`;
	const hero =
		`<aside class="hero"><span class="rule"></span><h2><span>${e(L.heroLine1)} </span><span>${e(L.heroLine2)} </span><span>${e(L.heroLine3)}</span></h2><p class="lede">${e(L.heroBody)}</p>${features(L.leftFeatures, "lg-")}</aside>`;
	const side =
		`<aside class="side"><ul class="rfs">${L.rightFeatures
			.map((it) => `<li class="rf"><span class="ftile">${icon(`lg-${it.icon}`)}</span><div class="rt"><strong>${e(it.title)}</strong><p>${e(it.body)}</p></div></li>`)
			.join("")}</ul></aside>`;
	return respond(L.title, "login", card + hero + side, true, init);
}

export function registerPage(f: FormState, init: PageInit = {}): Promise<Response> {
	const R = D.register;
	const card =
		`<section class="card">${stack()}<h1 class="ttl">${e(R.heading)}</h1><p class="sub">${e(R.subtitle)}</p>${errorBox(f.error)}` +
		`${ssoBlock(f, true)}<div class="div">${e(D.dividerSignUp)}</div>` +
		`<form method="post" action="/account/register">${csrfInput(f.csrf)}${emailField(f)}` +
		`${passwordField(D.passwordLabel, R.passwordPlaceholder, "new-password")}<p class="hint">${e(D.passwordHint)}</p>` +
		`${submitButton(R.submit)}</form>` +
		`<p class="alt">${e(R.haveAccount)} <a href="/account/login">${e(R.signIn)}</a></p>` +
		`${footer(" rule2")}</section>`;
	const hero =
		`<aside class="hero"><span class="rule"></span><h2>${e(R.heroLine1)}<br>${e(R.heroLine2)}</h2><p class="lede">${e(R.heroBody.replace(/ (\S+)$/, "\u00a0$1"))}</p>${features(R.features)}</aside>`;
	return respond(R.title, "reg", card + hero, true, init);
}

export function forgotPasswordPage(f: FormState, init: PageInit = {}): Promise<Response> {
	const F = D.forgot;
	const card =
		`<section class="card">${stack()}<h1 class="ttl">${e(F.heading)}</h1><p class="sub">${e(F.subtitle)}</p>${errorBox(f.error)}` +
		`<form method="post" action="/account/forgot-password">${csrfInput(f.csrf)}${emailField(f)}${submitButton(F.submit)}</form>` +
		`<div class="note"><span class="tile">${icon("mail")}</span><div><strong>${e(F.infoHeading)}</strong><p>${e(F.infoBody)}</p></div></div>` +
		`${backLink()}${footer()}</section>`;
	return respond(F.title, "center", card, false, init);
}

export function resetPasswordPage(f: FormState & { token: string }, init: PageInit = {}): Promise<Response> {
	const R = D.reset;
	const card =
		`<section class="card">${stack()}<h1 class="ttl">${e(R.heading)}</h1><p class="sub">${e(R.subtitle)}</p>${errorBox(f.error)}` +
		`<form method="post" action="/account/reset-password">${csrfInput(f.csrf)}<input type="hidden" name="token" value="${e(f.token)}">` +
		`${passwordField(R.passwordLabel, R.passwordPlaceholder, "new-password")}<p class="hint">${e(D.passwordHint)}</p>${submitButton(R.submit)}</form>` +
		`${footer()}</section>`;
	return respond(R.title, "center", card, true, init);
}

/** A centered state card: stacked logo, an icon tile, heading, text, then optional extra markup. */
function stateCard(title: string, glyph: string, tileCls: string, body: string[], extra: string): string {
	return `<section class="card">${stack()}<div class="tile lg${tileCls}">${icon(glyph)}</div><h1 class="ttl">${e(title)}</h1>` +
		`${body.map((text) => `<p class="msg">${e(text)}</p>`).join("")}${extra}${footer()}</section>`;
}

export function checkEmailPage(kind: "register" | "forgot", init: PageInit = {}): Promise<Response> {
	const C = D.checkEmail;
	const title = kind === "register" ? C.registerTitle : C.forgotTitle;
	const text = kind === "register" ? C.registerBody : C.forgotBody;
	return respond(title, "center", stateCard(title, "mail", "", [text, C.spamHint], backLink()), false, init);
}

export function verifyPage(ok: boolean, init: PageInit = {}): Promise<Response> {
	const V = D.verify;
	const inner = ok
		? stateCard(V.okTitle, "check", "", [V.okBody], linkButton("/account/login", V.okButton))
		: stateCard(V.invalidTitle, "alert", "", [V.invalidBody], linkButton("/account/login", V.invalidButton));
	return respond(ok ? V.okTitle : V.invalidTitle, "center", inner, false, init);
}

export function resetDonePage(init: PageInit = {}): Promise<Response> {
	const R = D.reset;
	return respond(R.doneTitle, "center", stateCard(R.doneTitle, "check", "", [R.doneBody], linkButton("/account/login", R.doneButton)), false, init);
}

export function resetInvalidPage(init: PageInit = {}): Promise<Response> {
	const R = D.reset;
	return respond(R.invalidTitle, "center", stateCard(R.invalidTitle, "alert", "", [R.invalidBody], linkButton("/account/forgot-password", R.invalidButton)), false, init);
}

export function connectGithubPage(f: { csrf: string; error?: string }, init: PageInit = {}): Promise<Response> {
	const C = D.connect;
	const form =
		`${errorBox(f.error)}<form method="post" action="/account/connect-github">${csrfInput(f.csrf)}` +
		`<button class="btn" type="submit">${icon("octocat", "gh")}${e(C.button)}</button></form>`;
	return respond(C.title, "center", stateCard(C.title, "octocat", " gh", [C.body, C.note], form), false, init);
}

export function connectConflictPage(init: PageInit = {}): Promise<Response> {
	const C = D.connect;
	return respond(C.conflictTitle, "center", stateCard(C.conflictTitle, "alert", "", [C.conflictBody], linkButton("/account/login", C.conflictButton)), false, init);
}

export function verifyConfirmPage(f: { csrf: string; token: string }, init: PageInit = {}): Promise<Response> {
	const V = D.verifyConfirm;
	const form = `<form method="post" action="/account/verify">${csrfInput(f.csrf)}<input type="hidden" name="token" value="${e(f.token)}">${submitButton(V.button)}</form>`;
	return respond(V.title, "center", stateCard(V.title, "mail", "", [V.body], form), false, init);
}

export interface SettingsView {
	csrf: string;
	email: string;
	githubLogin: string | null;
}

export function settingsPage(v: SettingsView, init: PageInit = {}): Promise<Response> {
	const T = D.settings;
	const rows =
		`<dl class="kv"><div><dt>${e(T.emailLabel)}</dt><dd>${e(v.email)}</dd></div>` +
		`<div><dt>${e(T.githubLabel)}</dt><dd>${e(v.githubLogin ?? T.githubNone)}</dd></div></dl>`;
	const connect =
		v.githubLogin === null
			? `<form method="post" action="/account/connect-github">${csrfInput(v.csrf)}<button class="btn ghost" type="submit">${icon("octocat", "gh")}${e(T.connectGithub)}</button></form>`
			: "";
	const signOut = `<form method="post" action="/account/logout">${csrfInput(v.csrf)}<button class="btn ghost" type="submit">${e(T.signOut)}</button></form>`;
	const remove = `<a class="btn ghost" href="/account/delete">${e(T.delete)}</a>`;
	const back = `<div class="back one"><a href="/app">${icon("back")}${e(T.toRuns)}</a></div>`;
	const card = `<section class="card">${stack()}<h1 class="ttl">${e(T.title)}</h1><p class="sub">${e(T.subtitle)}</p>${rows}${connect}${signOut}${remove}${back}${footer()}</section>`;
	return respond(T.title, "center", card, false, init);
}

export function deleteAccountPage(f: { csrf: string; hasPassword: boolean; error?: string }, init: PageInit = {}): Promise<Response> {
	const X = D.delete;
	const field = f.hasPassword ? passwordField(X.passwordLabel, X.passwordPlaceholder, "current-password") : emailField({}, X.emailLabel, X.emailPlaceholder);
	const cancel = `<div class="back one"><a href="/account/settings">${icon("back")}${e(X.cancel)}</a></div>`;
	const card =
		`<section class="card">${stack()}<h1 class="ttl">${e(X.title)}</h1><p class="sub">${e(X.subtitle)}</p>${errorBox(f.error)}` +
		`<form method="post" action="/account/delete">${csrfInput(f.csrf)}${field}` +
		`<button class="btn danger" type="submit">${e(X.submit)}</button></form>${cancel}${footer()}</section>`;
	return respond(X.title, "center", card, f.hasPassword, init);
}

export function deleteDonePage(init: PageInit = {}): Promise<Response> {
	const X = D.delete;
	return respond(X.doneTitle, "center", stateCard(X.doneTitle, "check", "", [X.doneBody], linkButton("/account/login", X.doneButton)), false, init);
}
