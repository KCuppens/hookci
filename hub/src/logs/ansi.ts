// Turns a job log's terminal output into safe HTML for the log viewer. Every
// character of the log is HTML-escaped; the only markup is the spans written
// here for SGR colours and styles. Every other escape sequence is dropped.

import { escapeHtml } from "../pages/layout";

const COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

// ESC, then: a CSI (params, intermediates, final byte, which a truncated log may lack);
// an OSC up to BEL, ST or the end of the line; or any other escape's intermediates and final byte.
const ESCAPE = /\x1b(?:\[([0-?]*)[ -/]*([@-~])?|\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|[ -/]*[0-~]?)/g;

interface Style {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	/** COLORS name, `bright-` prefixed for 90-97; empty for the default colour. */
	fg: string;
}

const PLAIN: Readonly<Style> = { bold: false, dim: false, italic: false, underline: false, fg: "" };

/** The 16 basic colours of a 256-colour index; null for the cube and greys, which are dropped. */
function indexedColor(n: number | undefined): string | null {
	if (n === undefined || n < 0 || n > 15) return null;
	return n < 8 ? COLORS[n] ?? null : `bright-${COLORS[n - 8]}`;
}

/** Applies one SGR's params (`1;31`, empty meaning 0) to style; codes outside the supported set are ignored. */
function applySgr(style: Style, params: string): void {
	const codes = params.split(";").map((p) => (p === "" ? 0 : /^[0-9]+$/.test(p) ? Number(p) : -1));
	for (let k = 0; k < codes.length; k++) {
		const code = codes[k] ?? -1;
		if (code === 0) Object.assign(style, PLAIN);
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 3) style.italic = true;
		else if (code === 4) style.underline = true;
		else if (code === 22) style.bold = style.dim = false;
		else if (code === 23) style.italic = false;
		else if (code === 24) style.underline = false;
		else if (code >= 30 && code <= 37) style.fg = COLORS[code - 30] ?? "";
		else if (code >= 90 && code <= 97) style.fg = `bright-${COLORS[code - 90]}`;
		else if (code === 39) style.fg = "";
		else if (code === 38 || code === 48) {
			// 38;5;n and 38;2;r;g;b carry their colour in the next params; 48 is background, which is not rendered.
			const mode = codes[k + 1];
			if (mode === 5) {
				const color = indexedColor(codes[k + 2]);
				if (code === 38 && color !== null) style.fg = color;
				k += 2;
			} else if (mode === 2) {
				k += 4;
			} else {
				k += 1;
			}
		}
	}
}

function classesOf(style: Style): string {
	const classes: string[] = [];
	if (style.bold) classes.push("c-bold");
	if (style.dim) classes.push("c-dim");
	if (style.italic) classes.push("c-italic");
	if (style.underline) classes.push("c-underline");
	if (style.fg) classes.push(`c-${style.fg}`);
	return classes.join(" ");
}

/** The log as HTML for a `<pre>`: escaped text with `<span class="c-...">` for SGR styles, every span closed. */
export function ansiToHtml(text: string): string {
	const style: Style = { ...PLAIN };
	let open = "";
	let out = "";
	let last = 0;
	for (const m of text.matchAll(ESCAPE)) {
		out += escapeHtml(text.slice(last, m.index));
		last = m.index + m[0].length;
		if (m[2] !== "m") continue;
		applySgr(style, m[1] ?? "");
		const classes = classesOf(style);
		if (classes === open) continue;
		if (open) out += "</span>";
		if (classes) out += `<span class="${classes}">`;
		open = classes;
	}
	out += escapeHtml(text.slice(last));
	return open ? `${out}</span>` : out;
}
