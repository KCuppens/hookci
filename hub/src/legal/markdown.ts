// The markdown subset the legal and support pages use: headings, paragraphs,
// lists, tables, inline code and links. Every piece of text goes through
// escapeHtml, and a link keeps its href only for http(s) or relative URLs, so a
// document can never put markup or script on the hub origin.

import { escapeHtml } from "../pages/layout";

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** `code`, or [label](url) where url may hold one level of balanced parentheses. */
const INLINE = /`([^`]+)`|\[([^\]]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** Browsers drop or fold these while parsing a URL, which could hide a scheme. */
const URL_HIDING = /[\u0000-\u0020\u007f\\]/;

/** True for an http(s) URL or a relative one; javascript:, data:, mailto: and the rest are not linked. */
function linkable(url: string): boolean {
	if (URL_HIDING.test(url)) return false;
	return /^https?:\/\//i.test(url) || !SCHEME.test(url);
}

function inline(text: string): string {
	let html = "";
	let last = 0;
	for (const m of text.matchAll(INLINE)) {
		html += escapeHtml(text.slice(last, m.index));
		const [whole, code, label = "", url = ""] = m;
		if (code !== undefined) html += `<code>${escapeHtml(code)}</code>`;
		else if (linkable(url)) html += `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
		else html += escapeHtml(label);
		last = m.index + whole.length;
	}
	return html + escapeHtml(text.slice(last));
}

function isTable(lines: readonly string[], i: number): boolean {
	return TABLE_ROW.test(lines[i] ?? "") && TABLE_RULE.test(lines[i + 1] ?? "");
}

function startsBlock(lines: readonly string[], i: number): boolean {
	const line = lines[i] ?? "";
	return HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) || isTable(lines, i);
}

/** HTML for md; anything outside the subset renders as escaped paragraph text. */
export function renderMarkdownSubset(md: string): string {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const html: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (!line.trim()) {
			i++;
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			const level = (heading[1] ?? "#").length;
			html.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
			i++;
			continue;
		}

		if (isTable(lines, i)) {
			const tableRows = [line];
			for (i += 2; i < lines.length && TABLE_ROW.test(lines[i] ?? ""); i++) tableRows.push(lines[i] ?? "");
			const [head = "", ...body] = tableRows.map((row, r) => {
				const tag = r === 0 ? "th" : "td";
				const cells = row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
				return `<tr>${cells.map((cell) => `<${tag}>${inline(cell.trim())}</${tag}>`).join("")}</tr>`;
			});
			html.push(`<table>\n<thead>${head}</thead>\n<tbody>\n${body.join("\n")}\n</tbody>\n</table>`);
			continue;
		}

		const marker = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
		if (marker) {
			const items: string[] = [];
			for (; i < lines.length && (lines[i] ?? "").trim(); i++) {
				const item = marker.exec(lines[i] ?? "");
				if (item) items.push(item[1] ?? "");
				else if (startsBlock(lines, i)) break;
				else items[items.length - 1] += ` ${(lines[i] ?? "").trim()}`;
			}
			const tag = marker === BULLET ? "ul" : "ol";
			html.push(`<${tag}>\n${items.map((item) => `<li>${inline(item)}</li>`).join("\n")}\n</${tag}>`);
			continue;
		}

		const text: string[] = [];
		do text.push((lines[i++] ?? "").trim());
		while (i < lines.length && (lines[i] ?? "").trim() && !startsBlock(lines, i));
		html.push(`<p>${inline(text.join(" "))}</p>`);
	}
	return html.join("\n");
}
