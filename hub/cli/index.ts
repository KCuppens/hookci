#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { packageVersion } from "./package.js";
import { scriptedPrompter, ttyPrompter } from "./prompts.js";
import { renderStateDir } from "./render.js";
import { SetupError, runSetup } from "./setup.js";
import { nodeExec } from "./wrangler.js";

export const USAGE = `Usage: zeroci-hub <command> [options]

Commands:
  setup     Create the Cloudflare resources and deploy a self-hosted hub
  upgrade   Deploy the hub version in this package to an existing setup
  render    Write wrangler.toml, the Worker and migrations into the state dir
  version   Print the zeroci-hub version

Options:
  --dir <path>     State directory (default: ./zeroci-hub)
  --yes            Answer yes to every confirmation and take the defaults
  --force-render   setup: render wrangler.toml and deploy again even if done
  --org <login>    setup: create the GitHub App under this organization
  -h, --help       Show this help
`;

export const DEFAULT_DIR = "./zeroci-hub";

const COMMANDS = ["setup", "upgrade", "render", "version"] as const;
type Command = (typeof COMMANDS)[number];

export interface ParsedArgs {
	command: Command;
	dir: string;
	yes: boolean;
	forceRender: boolean;
	/** GitHub organization to own the hub's GitHub App. */
	org?: string;
}

export type ParseResult = { kind: "run"; args: ParsedArgs } | { kind: "help" } | { kind: "usage-error"; message: string };

export function parseArgs(argv: string[]): ParseResult {
	let command: Command | undefined;
	let dir = DEFAULT_DIR;
	let yes = false;
	let forceRender = false;
	let org: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "-h" || arg === "--help") return { kind: "help" };
		if (arg === "--yes") {
			yes = true;
		} else if (arg === "--force-render") {
			forceRender = true;
		} else if (arg === "--dir" || arg.startsWith("--dir=")) {
			const value = arg === "--dir" ? argv[++i] : arg.slice("--dir=".length);
			if (!value) return { kind: "usage-error", message: "--dir needs a path" };
			dir = value;
		} else if (arg === "--org" || arg.startsWith("--org=")) {
			const value = arg === "--org" ? argv[++i] : arg.slice("--org=".length);
			if (!value) return { kind: "usage-error", message: "--org needs a login" };
			org = value;
		} else if (arg.startsWith("-")) {
			return { kind: "usage-error", message: `unknown option ${arg}` };
		} else if (command !== undefined) {
			return { kind: "usage-error", message: `unexpected argument ${arg}` };
		} else if ((COMMANDS as readonly string[]).includes(arg)) {
			command = arg as Command;
		} else {
			return { kind: "usage-error", message: `unknown command ${arg}` };
		}
	}
	if (command === undefined) return { kind: "usage-error", message: "no command given" };
	return { kind: "run", args: { command, dir, yes, forceRender, ...(org ? { org } : {}) } };
}

export interface Io {
	out: (s: string) => void;
	err: (s: string) => void;
}

const processIo: Io = {
	out: (s) => process.stdout.write(s),
	err: (s) => process.stderr.write(s),
};

/** Runs the CLI and returns the exit code: 0 ok, 1 failure, 2 usage error. */
export async function main(argv: string[], io: Io = processIo): Promise<number> {
	const parsed = parseArgs(argv);
	if (parsed.kind === "help") {
		io.out(USAGE);
		return 0;
	}
	if (parsed.kind === "usage-error") {
		io.err(`zeroci-hub: ${parsed.message}\n\n${USAGE}`);
		return 2;
	}
	const { command, dir, yes, forceRender, org } = parsed.args;
	try {
		switch (command) {
			case "version":
				io.out(`${packageVersion()}\n`);
				return 0;
			case "render": {
				const written = await renderStateDir(dir, yes ? scriptedPrompter({}) : ttyPrompter());
				io.out(written ? `Rendered ${dir}/wrangler.toml\n` : `Left ${dir}/wrangler.toml unchanged\n`);
				return 0;
			}
			case "setup": {
				const state = await runSetup({
					dir,
					yes,
					forceRender,
					...(org ? { org } : {}),
					exec: nodeExec(),
					prompter: ttyPrompter(),
					fetchFn: fetch,
					log: (line) => io.out(`${line}\n`),
				});
				io.out(`Hub deployed at ${state.base_url}\n`);
				return 0;
			}
			case "upgrade":
				io.err(`zeroci-hub: ${command} is not implemented in this version\n`);
				return 1;
		}
	} catch (err) {
		if (err instanceof SetupError) {
			const detail = err.detail ? `${err.detail.replace(/^/gm, "  ")}\n` : "";
			io.err(`zeroci-hub: ${err.message}\n${detail}hint: ${err.hint}\n`);
			return 1;
		}
		io.err(`zeroci-hub: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2));
}
