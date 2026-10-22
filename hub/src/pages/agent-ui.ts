// What the agent pages (list, one agent, pairing) share: their icons, the status
// chip, the platform text and the mono command box with its copy button.

import type { AgentRow } from "../db/agents";
import { S } from "../strings";
import { escapeHtml } from "./layout";
import { icon } from "./shell";

const A = S.agents;
const e = escapeHtml;

export const AGENT_ICONS: Record<string, string> = {
	copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
	plus: '<circle cx="12" cy="12" r="9.4"/><path d="M12 8v8M8 12h8"/>',
	info: '<circle cx="12" cy="12" r="9.4"/><path d="M12 11v5.2M12 7.7v.1"/>',
	link: '<path d="M10.3 13.7a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1.2 1.2M13.7 10.3a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1.2-1.2"/>',
	refresh: '<path d="M19.6 12a7.6 7.6 0 1 1-2.3-5.4M19.6 4.6v4.2h-4.2"/>',
	wifi: '<path d="M3.6 9.4a12.4 12.4 0 0 1 16.8 0M6.6 12.7a8 8 0 0 1 10.8 0M9.6 16a3.6 3.6 0 0 1 4.8 0M12 19.2h.01"/>',
	key: '<circle cx="8.4" cy="15.6" r="4"/><path d="m11.4 12.6 7.2-7.2M15.6 8.4l2.4 2.4M18.6 5.4l1.6 1.6"/>',
	terminal: '<path d="m5 7.5 5 4.5-5 4.5M12.5 17h6.5"/>',
};

export const AGENT_UI_CSS = `
.as{display:inline-flex;align-items:center;gap:9px;font-size:13.5px;font-weight:500;white-space:nowrap}
.as i{flex:none;width:11px;height:11px;border-radius:50%;background:#8b94a8}
.as b{display:inline-block;height:25px;padding:0 10px;border-radius:8px;font-weight:500;line-height:25px;background:#eceef2;color:#4a5470}
.as.online b{background:#dff6ea;color:#0f8f55}
.as.online i{background:#14b36f}
.as.revoked b{background:#fee6e7;color:#c8161f}
.as.revoked i{background:#e5333b}
.cb{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;border:1px solid #eceff4;border-radius:10px;background:#f6f7fa;color:#262d42;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:14px}
.cb code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;user-select:all}
.cb .cp{flex:none;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;background:none;color:#2a3147;cursor:pointer}
.cb .cp .ic{width:19px;height:19px}
.cb .cp[data-done]{color:#0e8a55}
@media (max-width:900px){
.cb{min-height:52px;padding-top:4px;padding-bottom:4px}
.cb code{white-space:normal;overflow-wrap:anywhere;text-overflow:clip}
.cb .cp{width:44px;height:44px}
}
`;

/** The agent's state as a chip: a dot and Online, Offline or Revoked. */
export function statusChip(status: AgentRow["status"]): string {
	return `<span class="as ${status}"><i></i><b>${e(A.status[status])}</b></span>`;
}

/** The agent's operating system (the reported release such as "Ubuntu 22.04", else the raw os) and architecture, each on its own line; empty parts are left out. */
export function platformLines(a: { os: string | null; arch: string | null; os_release?: string | null }): string {
	const parts = [a.os_release ?? a.os, a.arch].filter((p): p is string => p !== null && p !== "");
	return parts.map((p) => `<span>${e(p)}</span>`).join("");
}

/** A mono command with a copy button (shown by the page script; the text stays selectable without it). */
export function copyBox(text: string, cls = ""): string {
	return `<div class="cb${cls === "" ? "" : ` ${cls}`}"><code>${e(text)}</code><button type="button" class="cp" data-copy="${e(text)}" aria-label="${e(A.copy)}" hidden>${icon("copy")}</button></div>`;
}
