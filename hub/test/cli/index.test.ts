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

describe("zeroci-hub CLI", () => {
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

	it("reports upgrade as not implemented", async () => {
		const r = await run(["upgrade"]);
		expect(r.code).toBe(1);
		expect(r.err).toBe("zeroci-hub: upgrade is not implemented in this version\n");
	});

	it("prints a setup error as one line and a hint, without a stack", async () => {
		const dir = await mkdtemp(join(tmpdir(), "zeroci-hub-cli-"));
		try {
			await saveState(dir, { account_id: "a".repeat(32), version: "0.0.0", steps_done: ["preflight", "account"] });
			const r = await run(["setup", "--dir", dir]);
			expect(r.code).toBe(1);
			expect(r.err).toBe(
				"zeroci-hub: the setup state has no hub name\nhint: Use 3 to 41 lowercase letters, digits or dashes, starting with a letter.\n",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("parses --dir, --yes and --force-render", () => {
		expect(parseArgs(["render"])).toEqual({ kind: "run", args: { command: "render", dir: DEFAULT_DIR, yes: false, forceRender: false } });
		expect(parseArgs(["render", "--dir", "/tmp/x", "--yes"])).toEqual({ kind: "run", args: { command: "render", dir: "/tmp/x", yes: true, forceRender: false } });
		expect(parseArgs(["--dir=/tmp/y", "render"])).toEqual({ kind: "run", args: { command: "render", dir: "/tmp/y", yes: false, forceRender: false } });
		expect(parseArgs(["setup", "--force-render"])).toEqual({ kind: "run", args: { command: "setup", dir: DEFAULT_DIR, yes: false, forceRender: true } });
		expect(parseArgs(["render", "--dir"])).toEqual({ kind: "usage-error", message: "--dir needs a path" });
	});
});
