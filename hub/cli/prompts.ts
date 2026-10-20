import { createInterface } from "node:readline";

export interface Prompter {
	ask(q: string, def?: string): Promise<string>;
	confirm(q: string, def?: boolean): Promise<boolean>;
}

function parseYesNo(answer: string): boolean | null {
	const a = answer.trim().toLowerCase();
	if (a === "y" || a === "yes") return true;
	if (a === "n" || a === "no") return false;
	return null;
}

/** Reads one line from the terminal. A fresh interface per question lets the process exit once prompting is over. */
function readLine(prompt: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	return new Promise((resolve, reject) => {
		let answered = false;
		rl.once("line", (line) => {
			answered = true;
			rl.close();
			resolve(line.trim());
		});
		rl.once("close", () => {
			if (!answered) reject(new Error("input closed before the question was answered"));
		});
		rl.setPrompt(prompt);
		rl.prompt();
	});
}

/** Asks on stderr and reads answers from stdin, so stdout stays clean for output. */
export function ttyPrompter(): Prompter {
	return {
		async ask(q, def) {
			const answer = await readLine(def === undefined ? `${q}: ` : `${q} [${def}]: `);
			return answer === "" ? (def ?? "") : answer;
		},
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
 * Answers from a map keyed by the exact question text. An unscripted `ask`
 * takes its default and fails without one; an unscripted `confirm` answers yes,
 * which is what `--yes` means.
 */
export function scriptedPrompter(answers: Record<string, string>): Prompter {
	return {
		async ask(q, def) {
			const answer = answers[q] ?? def;
			if (answer === undefined) throw new Error(`no answer for "${q}" and it has no default`);
			return answer;
		},
		async confirm(q) {
			const answer = answers[q];
			if (answer === undefined) return true;
			const yes = parseYesNo(answer);
			if (yes === null) throw new Error(`answer "${answer}" to "${q}" is not yes or no`);
			return yes;
		},
	};
}
