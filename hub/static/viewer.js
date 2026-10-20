// Live tail for /logs/view while the job runs: follows /logs/stream and appends
// each chunk to the page. The ANSI handling is a port of hub/src/logs/ansi.ts.
// Log text only ever becomes text nodes and styles only span classNames, so
// nothing the log contains is parsed as HTML.
"use strict";

(() => {
	const log = document.getElementById("log");
	const status = document.getElementById("live");
	if (!log || !status || !log.dataset.stream) return;

	const COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
	const ESCAPE = /\x1b(?:\[([0-?]*)[ -/]*([@-~])?|\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|[ -/]*[0-~]?)/g;
	const PLAIN = { bold: false, dim: false, italic: false, underline: false, fg: "" };
	const style = { ...PLAIN };
	let open = "";
	let target = log;
	// An escape sequence a chunk ends inside of, prepended to the next chunk.
	let carry = "";

	function indexedColor(n) {
		if (n === undefined || n < 0 || n > 15) return null;
		return n < 8 ? COLORS[n] : `bright-${COLORS[n - 8]}`;
	}

	function applySgr(params) {
		const codes = params.split(";").map((p) => (p === "" ? 0 : /^[0-9]+$/.test(p) ? Number(p) : -1));
		for (let k = 0; k < codes.length; k++) {
			const code = codes[k];
			if (code === 0) Object.assign(style, PLAIN);
			else if (code === 1) style.bold = true;
			else if (code === 2) style.dim = true;
			else if (code === 3) style.italic = true;
			else if (code === 4) style.underline = true;
			else if (code === 22) style.bold = style.dim = false;
			else if (code === 23) style.italic = false;
			else if (code === 24) style.underline = false;
			else if (code >= 30 && code <= 37) style.fg = COLORS[code - 30];
			else if (code >= 90 && code <= 97) style.fg = `bright-${COLORS[code - 90]}`;
			else if (code === 39) style.fg = "";
			else if (code === 38 || code === 48) {
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

	function classesOf() {
		const classes = [];
		if (style.bold) classes.push("c-bold");
		if (style.dim) classes.push("c-dim");
		if (style.italic) classes.push("c-italic");
		if (style.underline) classes.push("c-underline");
		if (style.fg) classes.push(`c-${style.fg}`);
		return classes.join(" ");
	}

	function appendText(text) {
		if (text) target.appendChild(document.createTextNode(text));
	}

	function render(chunk, final) {
		let text = carry + chunk;
		carry = "";
		const esc = text.lastIndexOf("\x1b");
		if (!final && esc !== -1 && !text.includes("\n", esc)) {
			carry = text.slice(esc);
			text = text.slice(0, esc);
		}
		let last = 0;
		for (const m of text.matchAll(ESCAPE)) {
			appendText(text.slice(last, m.index));
			last = m.index + m[0].length;
			if (m[2] !== "m") continue;
			applySgr(m[1] || "");
			const classes = classesOf();
			if (classes === open) continue;
			open = classes;
			target = log;
			if (classes) {
				target = document.createElement("span");
				target.className = classes;
				log.appendChild(target);
			}
		}
		appendText(text.slice(last));
	}

	const source = new EventSource(log.dataset.stream);
	let stopped = false;

	function stop(message) {
		if (stopped) return;
		stopped = true;
		source.close();
		render("", true);
		status.textContent = message;
	}

	source.addEventListener("log", (e) => {
		const following = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
		render(JSON.parse(e.data).text, false);
		if (following) window.scrollTo(0, document.body.scrollHeight);
	});
	source.addEventListener("eof", () => stop(status.dataset.finished));
	source.addEventListener("offline", () => stop(status.dataset.offline));
	source.addEventListener("error", () => stop(status.dataset.lost));
})();
