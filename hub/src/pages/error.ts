import { logEvent } from "../observability";
import { S } from "../strings";
import { ulid } from "../ulid";
import { GLYPH_CLOCKDOC, GLYPH_COPY, GLYPH_DOCX, GLYPH_EXCLAIM, GLYPH_GAUGE, GLYPH_LINKOFF, GLYPH_NO } from "./error-glyphs";
import { escapeHtml } from "./layout";
import { icon, shellResponse, siteNav } from "./shell";

// The shared error page: a compact header, a coloured glyph, the HubError code, a title and message, one
// action and a Request ID card. Every code a browser flow can end on has its own copy and glyph (S.errorPage);
// any other code gets the fallback. Static markup; one small script reveals the copy button.

const T = S.errorPage;
const e = escapeHtml;

interface ErrorCopy {
	title: string;
	lines: readonly string[];
}

type Tone = "red" | "coral" | "blue" | "slate" | "amber";
type Action = "restart" | "signIn" | "dashboard";

interface Variant {
	glyph: string;
	tone: Tone;
	action: Action;
}

const COPY: Readonly<Record<string, ErrorCopy | undefined>> = T.codes;

const EXCLAIM: Variant = { glyph: GLYPH_EXCLAIM, tone: "red", action: "restart" };
const NO_ACCESS: Variant = { glyph: GLYPH_NO, tone: "coral", action: "signIn" };
const RATE: Variant = { glyph: GLYPH_GAUGE, tone: "amber", action: "dashboard" };

/** The glyph, colour and action per code; a code missing here falls back to EXCLAIM. */
const VARIANTS: Readonly<Record<string, Variant | undefined>> = {
	oauth_state_invalid: EXCLAIM,
	github_oauth_failed: EXCLAIM,
	github_error: EXCLAIM,
	github_unavailable: EXCLAIM,
	slack_oauth_failed: EXCLAIM,
	slack_scope_mismatch: EXCLAIM,
	github_no_access: NO_ACCESS,
	installation_admin_required: NO_ACCESS,
	log_expired: { glyph: GLYPH_CLOCKDOC, tone: "blue", action: "dashboard" },
	log_sig_invalid: { glyph: GLYPH_LINKOFF, tone: "red", action: "dashboard" },
	log_not_found: { glyph: GLYPH_DOCX, tone: "slate", action: "dashboard" },
	rate_limited: RATE,
	pair_rate_limited: RATE,
};

// The copy button's confirmation tick, on the shared 24 grid.
const ICONS: Record<string, string> = {
	"e-tick": `<path stroke-width="1.8" d="m5.5 12.8 4.2 4.2 8.8-9.6"/>`,
};

const CSS = `
.p-error{--nh:63px;--ls:.0866;--bmw:34;--bww:77.5;--bgap:8.2;--bwy:7.4;--ry:1px;--nfs:11px;display:flex;flex-direction:column;background:#fcfcfc;will-change:opacity}
.p-error .nav{border-bottom:1px solid #f0f1f4}
.p-error .links{display:flex;gap:29px;margin-right:0}
.p-error .links a{color:#5b6784}
.err{position:relative;z-index:1;display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:0 24px 7px;text-align:center}
.ei{display:grid;place-items:center;width:86px;height:86px;border-radius:50%;background:var(--ebg);color:var(--efg)}
.ei .gl{width:86px;height:86px;fill:currentColor;fill-rule:evenodd}
.t-red{--ebg:#fee3e1;--efg:#ed090d}
.t-coral{--ebg:#fee5e0;--efg:#fb5435}
.t-blue{--ebg:#e1effd;--efg:#0687f0}
.t-slate{--ebg:#eef0f2;--efg:#656d80}
.t-amber{--ebg:#fef1de;--efg:#fd9408}
.ec{margin-top:19px;font-family:SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12px;line-height:14px;letter-spacing:.015em;color:#70778c}
.err h1{margin-top:8px;font-size:29px;line-height:34px;font-weight:700;letter-spacing:-.04em;color:#070d19}
.em{max-width:420px;margin-top:8px;font-size:15.5px;line-height:23px;letter-spacing:-.02em;color:#636d83}
.em span{display:block}
.ea{display:flex;justify-content:center;margin-top:20px}
.ea .btn{width:auto;min-width:249px;height:45px;gap:12px;padding:0 32px;background:#101720;color:#f8f9fa;font-size:14.5px;font-weight:500;border-radius:6px}
.ea .btn.ghost{min-width:214px;border-color:#e6e9ef;background:#fdfdfd;color:#090b15;letter-spacing:-.025em}
.ea .gh{width:24px;height:24px}
.rq{display:flex;align-items:center;justify-content:space-between;width:min(420px,100%);margin-top:27px;padding:11px 15px 12px 18px;border-radius:8px;background:#f6f7fa;text-align:left}
.rq span{display:block;font-size:12px;line-height:19px;letter-spacing:-.01em;color:#6e768c}
.rq .ri{margin-top:1px;font-size:11.5px;letter-spacing:.01em;color:#6f768b;user-select:all}
.cp{display:grid;place-items:center;flex:none;width:24px;height:24px;border:0;background:none;color:#686e85;cursor:pointer}
.cp .ic,.cp .cc{width:24px;height:24px}
.cp .cc{fill:currentColor;fill-rule:evenodd}
.cp[hidden],.cp .ok,.cp.done .cc{display:none}
.cp.done .ok{display:block}
@media (max-width:900px){
.p-error .links{display:none}
.err{padding:24px 20px 24px}
.ec,.err h1,.em{overflow-wrap:anywhere}
.ea{width:100%}
.ea .btn,.ea .btn.ghost{width:100%;min-width:0;max-width:420px;padding:0 20px}
.rq .ri{font-size:12px}
.cp{position:relative}
.cp::after{content:"";position:absolute;inset:-10px}
}
`;

// Reveals the copy button once the clipboard is available; without script the id stays selectable text.
const SCRIPT = `(function(){var b=document.getElementById("rq-copy"),t=document.getElementById("rq-id");if(!b||!t||!navigator.clipboard)return;b.hidden=false;b.addEventListener("click",function(){navigator.clipboard.writeText(t.textContent).then(function(){b.classList.add("done");b.setAttribute("aria-label",${JSON.stringify(T.copiedRequestId)})})})})();`;

function action(kind: Action): string {
	if (kind === "restart") return `<a class="btn" href="/start">${icon("github", "gh")}<span>${e(T.actions.restart)}</span></a>`;
	if (kind === "signIn") return `<a class="btn" href="/login">${icon("github", "gh")}<span>${e(T.actions.signIn)}</span></a>`;
	return `<a class="btn ghost" href="/">${e(T.actions.dashboard)}</a>`;
}

/**
 * The page for a failed browser flow: the code's glyph, title and message, one action and a Request ID that
 * is also sent in the X-Request-Id header and logged with the code, so a support request can be traced.
 */
export async function errorPage(code: string, status: number, cookies: string[] = []): Promise<Response> {
	const variant = VARIANTS[code] ?? EXCLAIM;
	const copy = COPY[code] ?? T.fallback;
	const requestId = `req_${ulid().slice(0, 20).toUpperCase()}`;
	logEvent("error_page", { request_id: requestId, code, status });
	const main =
		`<main class="err"><div class="ei t-${variant.tone}"><svg class="gl" viewBox="0 0 86 86" aria-hidden="true" focusable="false"><path d="${variant.glyph}"/></svg></div><p class="ec">${e(code)}</p><h1>${e(copy.title)}</h1>` +
		`<p class="em">${copy.lines.map((line) => `<span>${e(line)}</span>`).join("")}</p><div class="ea">${action(variant.action)}</div>` +
		`<section class="rq" aria-label="${e(T.requestId)}"><div><span>${e(T.requestId)}</span><span class="ri" id="rq-id">${requestId}</span></div>` +
		`<button class="cp" id="rq-copy" type="button" hidden aria-label="${e(T.copyRequestId)}"><svg class="cc" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${GLYPH_COPY}"/></svg>${icon("e-tick", "ok")}</button></section></main>`;
	const res = await shellResponse(
		{ title: copy.title, bodyClass: "p-error", css: CSS, body: `${siteNav("")}${main}`, icons: ICONS, script: SCRIPT, forms: false },
		{ status, cookies },
	);
	res.headers.set("X-Request-Id", requestId);
	return res;
}
