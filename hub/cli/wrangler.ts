import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Exec = (args: string[], opts?: { stdin?: string; cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>;

/** A wrangler invocation that exited non-zero. Secrets travel on stdin, so `args` is safe to show. */
export class WranglerError extends Error {
	constructor(
		public readonly args: string[],
		public readonly result: ExecResult,
	) {
		super(`wrangler ${args.join(" ")} exited with code ${result.code}`);
		this.name = "WranglerError";
	}
}

/**
 * The wrangler CLI script of the wrangler this package depends on, resolved
 * with Node module resolution from this module. npm may hoist the dependency
 * next to the package instead of under its own node_modules, so the path is
 * resolved rather than hardcoded; a globally installed wrangler is never used.
 */
function wranglerScript(): string {
	const pkgPath = createRequire(import.meta.url).resolve("wrangler/package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: Record<string, string> };
	const bin = pkg.bin.wrangler;
	if (!bin) throw new Error(`${pkgPath} declares no wrangler bin`);
	return join(dirname(pkgPath), bin);
}

/** Runs the package's own wrangler with the current Node binary and collects its output. */
export function nodeExec(): Exec {
	const script = wranglerScript();
	return (args, opts = {}) =>
		new Promise<ExecResult>((resolve, reject) => {
			const child = spawn(process.execPath, [script, ...args], {
				cwd: opts.cwd,
				env: { ...process.env, ...opts.env },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("error", reject);
			child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
			child.stdin.end(opts.stdin ?? "");
		});
}
