import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export interface Prompter {
	ask(q: string, def?: string): Promise<string>;
	/** Like `ask` without a default, but the typed answer is not echoed. */
	secret(q: string): Promise<string>;
	confirm(q: string, def?: boolean): Promise<boolean>;
}

function parseYesNo(answer: string): boolean | null {
	const a = answer.trim().toLowerCase();
	if (a === "y" || a === "yes") return true;
	if (a === "n" || a === "no") return false;
	return null;
}

/** Swallows readline's echo of what is typed, so a secret never shows on screen. */
const muted = new Writable({ write: (_chunk, _encoding, done) => done() });

/**
 * Reads one line from the terminal; `hidden` keeps the answer off the screen.
 * A fresh interface per question lets the process exit once prompting is over.
 */
function readLine(prompt: string, hidden = false): Promise<string> {
	const rl = hidden
		? createInterface({ input: process.stdin, output: muted, terminal: process.stdin.isTTY === true })
		: createInterface({ input: process.stdin, output: process.stderr });
	return new Promise((resolve, reject) => {
		let answered = false;
		rl.once("line", (line) => {
			answered = true;
			rl.close();
			if (hidden) process.stderr.write("\n");
			resolve(line.trim());
		});
		rl.once("close", () => {
			if (!answered) reject(new Error("input closed before the question was answered"));
		});
		if (hidden) {
			process.stderr.write(prompt);
		} else {
			rl.setPrompt(prompt);
			rl.prompt();
		}
	});
}

/** Asks on stderr and reads answers from stdin, so stdout stays clean for output. */
export function ttyPrompter(): Prompter {
	return {
		async ask(q, def) {
			const answer = await readLine(def === undefined ? `${q}: ` : `${q} [${def}]: `);
			return answer === "" ? (def ?? "") : answer;
		},
		secret: (q) => readLine(`${q}: `, true),
		async confirm(q, def = false) {
			for (;;) {
				const answer = await readLine(`${q} ${def ? "[Y/n]" : "[y/N]"}: `);
				if (answer === "") return def;
				const yes = parseYesNo(answer);
				if (yes !== null) return yes;
			}
		},
	};
}

/**
 * Answers from a map keyed by the exact question text; a list answers the
 * same question in turn, one entry per asking. An unscripted `ask` takes its
 * default and fails without one, as does an unscripted `secret`; an
 * unscripted `confirm` answers yes, which is what `--yes` means.
 */
export function scriptedPrompter(answers: Record<string, string | string[]>): Prompter {
	const asked = new Map<string, number>();
	const next = (q: string): string | undefined => {
		const scripted = answers[q];
		if (!Array.isArray(scripted)) return scripted;
		const n = asked.get(q) ?? 0;
		if (n >= scripted.length) throw new Error(`all ${scripted.length} answers to "${q}" are used up`);
		asked.set(q, n + 1);
		return scripted[n];
	};
	return {
		async ask(q, def) {
			const answer = next(q) ?? def;
			if (answer === undefined) throw new Error(`no answer for "${q}" and it has no default`);
			return answer;
		},
		async secret(q) {
			const answer = next(q);
			if (answer === undefined) throw new Error(`no answer for "${q}"`);
			return answer;
		},
		async confirm(q) {
			const answer = next(q);
			if (answer === undefined) return true;
			const yes = parseYesNo(answer);
			if (yes === null) throw new Error(`answer "${answer}" to "${q}" is not yes or no`);
			return yes;
		},
	};
}
