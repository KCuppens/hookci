import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { type Exec, type ExecResult, WranglerError, nodeExec } from "../../cli/wrangler.js";

describe("nodeExec", () => {
	it("runs the package's own wrangler", async () => {
		const { version } = createRequire(import.meta.url)("wrangler/package.json") as { version: string };
		const r = await nodeExec()(["--version"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain(version);
	}, 60_000);
});

describe("WranglerError", () => {
	it("names the failed command without stdin content", async () => {
		const calls: { args: string[]; stdin?: string }[] = [];
		const fake: Exec = async (args, opts) => {
			calls.push({ args, stdin: opts?.stdin });
			return { code: 1, stdout: "", stderr: "Authentication error" };
		};
		const args = ["secret", "put", "SESSION_SECRET"];
		const result: ExecResult = await fake(args, { stdin: "s3cret" });
		const err = new WranglerError(args, result);
		expect(err.message).toBe("wrangler secret put SESSION_SECRET exited with code 1");
		expect(err.message).not.toContain("s3cret");
		expect(err.result.stderr).toBe("Authentication error");
		expect(calls).toEqual([{ args, stdin: "s3cret" }]);
	});
});
