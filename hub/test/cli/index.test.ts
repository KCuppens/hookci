import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DIR, USAGE, main, parseArgs } from "../../cli/index.js";
import { packageRoot } from "../../cli/package.js";

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

	it("reports setup and upgrade as not implemented", async () => {
		for (const command of ["setup", "upgrade"]) {
			const r = await run([command]);
			expect(r.code).toBe(1);
			expect(r.err).toBe(`zeroci-hub: ${command} is not implemented in this version\n`);
		}
	});

	it("parses --dir and --yes", () => {
		expect(parseArgs(["render"])).toEqual({ kind: "run", args: { command: "render", dir: DEFAULT_DIR, yes: false } });
		expect(parseArgs(["render", "--dir", "/tmp/x", "--yes"])).toEqual({ kind: "run", args: { command: "render", dir: "/tmp/x", yes: true } });
		expect(parseArgs(["--dir=/tmp/y", "render"])).toEqual({ kind: "run", args: { command: "render", dir: "/tmp/y", yes: false } });
		expect(parseArgs(["render", "--dir"])).toEqual({ kind: "usage-error", message: "--dir needs a path" });
	});
});
