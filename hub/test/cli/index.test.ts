import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DIR, USAGE, main, parseArgs } from "../../cli/index.js";
import { packageRoot } from "../../cli/package.js";
import { saveState } from "../../cli/state.js";

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
	let out = "";
	let err = "";
	const code = await main(argv, { out: (s) => (out += s), err: (s) => (err += s) });
	return { code, out, err };
}

describe("hookci-hub CLI", () => {
	it("exits 2 with usage on an unknown command", async () => {
		const r = await run(["frobnicate"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("unknown command frobnicate");
		expect(r.err).toContain(USAGE);
		expect(r.out).toBe("");
	});

	it("exits 2 with usage on no command or an unknown option", async () => {
		expect((await run([])).code).toBe(2);
		const r = await run(["render", "--force"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("unknown option --force");
	});

	it("prints the package version", async () => {
		const pkg = JSON.parse(await readFile(join(packageRoot(), "package.json"), "utf8")) as { version: string };
		expect(await run(["version"])).toEqual({ code: 0, out: `${pkg.version}\n`, err: "" });
	});

	it("prints usage for --help", async () => {
		expect(await run(["--help"])).toEqual({ code: 0, out: USAGE, err: "" });
	});

	it("refuses upgrade without a setup state, with the setup hint", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hookci-hub-cli-"));
		try {
			const r = await run(["upgrade", "--dir", dir, "--dry-run"]);
			expect(r.code).toBe(1);
			expect(r.err).toBe(`hookci-hub: no hookci-hub setup state in ${dir}\nhint: run hookci-hub setup first\n`);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("prints a setup error as one line and a hint, without a stack", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hookci-hub-cli-"));
		try {
			await saveState(dir, { account_id: "a".repeat(32), version: "0.0.0", steps_done: ["preflight", "account"] });
			const r = await run(["setup", "--dir", dir]);
			expect(r.code).toBe(1);
			expect(r.err).toBe(
				"hookci-hub: the setup state has no hub name\nhint: Use 3 to 41 lowercase letters, digits or dashes, starting with a letter.\n",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("parses --dir, --yes, --force-render, --dry-run and --no-slack", () => {
		const defaults = { dir: DEFAULT_DIR, yes: false, forceRender: false, dryRun: false, noSlack: false };
		expect(parseArgs(["render"])).toEqual({ kind: "run", args: { ...defaults, command: "render" } });
		expect(parseArgs(["render", "--dir", "/tmp/x", "--yes"])).toEqual({ kind: "run", args: { ...defaults, command: "render", dir: "/tmp/x", yes: true } });
		expect(parseArgs(["--dir=/tmp/y", "render"])).toEqual({ kind: "run", args: { ...defaults, command: "render", dir: "/tmp/y" } });
		expect(parseArgs(["setup", "--force-render"])).toEqual({ kind: "run", args: { ...defaults, command: "setup", forceRender: true } });
		expect(parseArgs(["upgrade", "--dry-run"])).toEqual({ kind: "run", args: { ...defaults, command: "upgrade", dryRun: true } });
		expect(parseArgs(["setup", "--no-slack"])).toEqual({ kind: "run", args: { ...defaults, command: "setup", noSlack: true } });
		expect(parseArgs(["render", "--dir"])).toEqual({ kind: "usage-error", message: "--dir needs a path" });
	});
});
