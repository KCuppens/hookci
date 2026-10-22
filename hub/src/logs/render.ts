// What the log viewer shows of a stored log: the first VIEW_BYTES of the text, split into lines, with ANSI colours turned into
// escaped spans. Nothing of the log reaches the page except through escapeHtml, and the only markup produced here is span elements
// whose classes come from a fixed set (c0-c15, g0-g15, fb, fd, fi, fu).

import { escapeHtml } from "../pages/layout";
import { splitStamp } from "./stamp";

/** The viewer renders at most this many bytes of a log; the raw and download routes serve all of it. */
export const VIEW_BYTES = 2_097_152;

export interface LogHead {
	text: string;
	/** True when the log is longer than VIEW_BYTES and the text ends at a line boundary before the end. */
	cut: boolean;
}

/** Reads up to max bytes of a decompressed log stream as text, stopping early (and cancelling the stream) once the cap is reached. */
export async function readLogHead(body: ReadableStream<Uint8Array>, max: number): Promise<LogHead> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let size = 0;
	let cut = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (size + value.byteLength > max) {
			text += decoder.decode(value.subarray(0, max - size), { stream: true });
			cut = true;
			await reader.cancel();
			break;
		}
		size += value.byteLength;
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	if (cut) text = text.slice(0, text.lastIndexOf("\n") + 1) || text;
	return { text, cut };
}

interface Style {
	fg: number;
	bg: number;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
}

const RESET: Style = { fg: -1, bg: -1, bold: false, dim: false, italic: false, underline: false };

/** A CSI sequence (group 1 its parameters, group 2 its final byte), an OSC string, a lone escape pair or a stray control character. */
const TOKEN = new RegExp(
	"\\x1b\\[([0-9;:?]*)[\\x20-\\x2f]*([\\x40-\\x7e])|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?|\\x1b[\\x40-\\x5f]|[\\x00-\\x08\\x0b-\\x1f\\x7f]",
	"g",
);

/** Applies one SGR sequence ("1;31", "38;5;12", "0") to a style. Colours beyond the 16 basic ones are dropped. */
function applySgr(style: Style, params: string): void {
	const p = params === "" ? [0] : params.split(/[;:]/).map(Number);
	for (let i = 0; i < p.length; i++) {
		const n = p[i] ?? 0;
		if (n === 0) Object.assign(style, RESET);
		else if (n === 1) style.bold = true;
		else if (n === 2) style.dim = true;
		else if (n === 3) style.italic = true;
		else if (n === 4) style.underline = true;
		else if (n === 22) style.bold = style.dim = false;
		else if (n === 23) style.italic = false;
		else if (n === 24) style.underline = false;
		else if (n === 39) style.fg = -1;
		else if (n === 49) style.bg = -1;
		else if (n >= 30 && n <= 37) style.fg = n - 30;
		else if (n >= 90 && n <= 97) style.fg = n - 82;
		else if (n >= 40 && n <= 47) style.bg = n - 40;
		else if (n >= 100 && n <= 107) style.bg = n - 92;
		else if (n === 38 || n === 48) {
			const mode = p[i + 1];
			const index = p[i + 2] ?? -1;
			if (mode === 5 && index >= 0 && index < 16) {
				if (n === 38) style.fg = index;
				else style.bg = index;
			}
			i += mode === 5 ? 2 : mode === 2 ? 4 : 0;
		}
	}
}

function classOf(style: Style): string {
	const names = [
		style.fg >= 0 ? `c${style.fg}` : "",
		style.bg >= 0 ? `g${style.bg}` : "",
		style.bold ? "fb" : "",
		style.dim ? "fd" : "",
		style.italic ? "fi" : "",
		style.underline ? "fu" : "",
	];
	return names.filter(Boolean).join(" ");
}

/** One carriage-return-free segment to HTML; the style carries on into the next segment and line like a terminal's. */
function renderSegment(segment: string, style: Style, emit: boolean): string {
	let out = "";
	let at = 0;
	const put = (to: number) => {
		const chunk = segment.slice(at, to);
		if (!emit || chunk === "") return;
		const cls = classOf(style);
		out += cls === "" ? escapeHtml(chunk) : `<span class="${cls}">${escapeHtml(chunk)}</span>`;
	};
	for (const m of segment.matchAll(TOKEN)) {
		put(m.index);
		at = m.index + m[0].length;
		if (m[2] === "m") applySgr(style, m[1] ?? "");
	}
	put(segment.length);
	return out;
}

/** One line of a log: its timestamp when the agent stamped it, and its text as escaped HTML. */
export interface LogLine {
	/** The prefix's UTC time as ISO 8601 ("2026-05-05T14:32:01.123Z"), or null for a line without one (a log from an older agent). */
	ts: string | null;
	text: string;
}

/**
 * The lines of a log: the timestamp prefix of each, and the rest as escaped HTML. A carriage return rewinds to the start of the
 * line the way a terminal does (progress bars show their last state), after the prefix; colours and attributes persist across
 * lines until reset.
 */
export function renderLines(text: string): LogLine[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const style: Style = { ...RESET };
	return lines.map((line) => {
		const { ts, rest } = splitStamp(line);
		const segments = rest.replace(/\r+$/, "").split("\r");
		return { ts, text: segments.map((s, i) => renderSegment(s, style, i === segments.length - 1)).join("") };
	});
}
