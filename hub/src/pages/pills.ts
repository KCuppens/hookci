// The run state looks of the dashboard: the one table of every state's tone, badge icon, round glyph and pill,
// and the pill itself (a coloured capsule with the state's mark and name) of the run list and the repository
// list. The stylesheet and the icons are handed to appPage by each page that shows pills.

import { S } from "../strings";
import { escapeHtml } from "./layout";
import { icon } from "./shell";

const e = escapeHtml;

export interface StateLook {
	/** The colour class of the state badge and the round mark. */
	tone: string;
	/** The badge's icon. */
	icon: string;
	/** The glyph inside the round mark. */
	glyph: string;
	/** The colour class of the pill. */
	pill: string;
	/** The pill's icon. */
	pillIcon: string;
}

const QUEUED: StateLook = { tone: "", icon: "clock", glyph: "g-dots", pill: "qd", pillIcon: "p-queued" };
const RUNNING: StateLook = { tone: "busy", icon: "play", glyph: "g-play", pill: "rn", pillIcon: "p-running" };

/** An unknown state looks like queued, with the plain dots as its badge icon. */
const UNKNOWN: StateLook = { ...QUEUED, icon: "dots" };

const STATES: Record<string, StateLook> = {
	success: { tone: "ok", icon: "check", glyph: "g-tick", pill: "ok", pillIcon: "p-success" },
	failed: { tone: "bad", icon: "x", glyph: "g-x", pill: "fl", pillIcon: "p-failed" },
	interrupted: { tone: "bad", icon: "alert", glyph: "g-bang", pill: "it", pillIcon: "p-interrupted" },
	received: QUEUED,
	pending: QUEUED,
	queued: QUEUED,
	gated: { tone: "wait", icon: "shield", glyph: "g-pause", pill: "gt", pillIcon: "p-gated" },
	running: RUNNING,
	verifying: { tone: "pur", icon: "search", glyph: "g-eye", pill: "vf", pillIcon: "p-verifying" },
	rolling_back: { ...RUNNING, icon: "back" },
	superseded: { tone: "pur", icon: "layers", glyph: "g-stack", pill: "sp", pillIcon: "p-superseded" },
	cancelled: { tone: "", icon: "ban", glyph: "g-ban", pill: "cn", pillIcon: "p-cancelled" },
	skipped: { tone: "", icon: "skip", glyph: "g-minus", pill: "sk", pillIcon: "p-skipped" },
};

export function stateLook(state: string): StateLook {
	return STATES[state] ?? UNKNOWN;
}

export { PILL_ICONS } from "./pill-icons";

export const PILL_CSS = `
.rp{display:inline-flex;align-items:center;gap:9.5px;min-width:93px;height:28px;margin:-4px 0;padding:0 12px 0 7px;border-radius:14px;vertical-align:top;font-size:13px;line-height:28px;font-weight:450;letter-spacing:-.04em;white-space:nowrap}
a.rp,a.rp:hover{text-decoration:none}
.rp .ic{width:20px;height:20px;flex:none;stroke:none}
.rp.gt{background:light-dark(#fef3d6,#29210c);color:light-dark(#7d2a05,#d87d5c);min-width:93px}
.rp.rn{background:light-dark(#e5effe,#252729);color:light-dark(#074ee4,#4b95ff);min-width:97px}
.rp.qd{background:light-dark(#f1f2f6,#222225);color:light-dark(#212d45,#8696b3);min-width:97px}
.rp.ok{background:light-dark(#d8f3e6,#192c24);color:light-dark(#0d613d,#5aa47b);min-width:98px}
.rp.fl{background:light-dark(#fee4e6,#2c2929);color:light-dark(#c4090c,#ff5f4f);min-width:93px}
.rp.sp{background:light-dark(#eee6fe,#2a2434);color:light-dark(#351ec3,#7d8bff);min-width:110px}
.rp.cn{background:light-dark(#e9ebef,#292a2c);color:light-dark(#2d3951,#8796b2);min-width:105px}
.rp.sk{background:light-dark(#f1f2f6,#222225);color:light-dark(#2d3851,#8896b3);min-width:97px}
.rp.it{background:light-dark(#fee7e8,#2a2727);color:light-dark(#d80000,#ff5f51);min-width:107px}
.rp.vf{background:light-dark(#ebe1fd,#2e2639);color:light-dark(#3816c7,#818aff);min-width:98px}
`;

/** The pill of a run state linking to href (already escaped). */
export function runPill(state: string, href: string): string {
	const look = stateLook(state);
	return `<a class="rp ${look.pill}" href="${href}">${icon(look.pillIcon)}${e(S.dashboard.list.states[state] ?? state)}</a>`;
}
