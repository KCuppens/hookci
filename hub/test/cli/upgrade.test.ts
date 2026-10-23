import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { packageRoot } from "../../cli/package.js";
import { scriptedPrompter } from "../../cli/prompts.js";
import { readTemplate } from "../../cli/render.js";
import { SETUP_STEPS, SetupError, type SetupErrorCode, wranglerTomlFor } from "../../cli/setup.js";
import { type HubState, loadState, saveState } from "../../cli/state.js";
import { compareSemver, planUpgrade, runUpgrade, type UpgradeOptions } from "../../cli/upgrade.js";
import type { Exec, ExecResult } from "../../cli/wrangler.js";
import { type FakeScript, fakeExec } from "./fake-exec.js";

const pkg = vi.hoisted(() => ({ version: "0.4.0" }));
vi.mock("../../cli/package.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	packageVersion: () => pkg.version,
}));

const WORKERS_DEV = "https://hookci-hub.acme.workers.dev";
const LIST = ["d1", "migrations", "list", "hookci-hub-db", "--remote"];
const APPLY = ["d1", "migrations", "apply", "hookci-hub-db", "--remote"];
const PENDING = ["0015_sink_retries.sql", "0016_agent_versions.sql"];
const CONFIRM = "Upgrade hookci-hub to 0.4.0?";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const is =
	(...prefix: string[]) =>
	(args: string[]) =>
		prefix.every((p, i) => args[i] === p);

const fx: Record<string, string> = {};
let tmp: string;
let root: string;
let dir: string;
let state: HubState;
let installedToml: string;

beforeAll(async () => {
	for (const name of ["d1-migrations-list-pending.txt", "d1-migrations-list-none.txt", "deploy.txt"]) {
		fx[name] = await readFile(join(packageRoot(), "test", "cli", "fixtures", name), "utf8");
	}
});

beforeEach(async () => {
	pkg.version = "0.4.0";
	tmp = await mkdtemp(join(tmpdir(), "hookci-hub-upgrade-test-"));
	root = join(tmp, "pkg");
	dir = join(tmp, "state");
	await mkdir(join(root, "templates"), { recursive: true });
	await mkdir(join(root, "dist", "worker"), { recursive: true });
	await mkdir(join(root, "migrations"), { recursive: true });
	await writeFile(join(root, "templates", "wrangler.self-hosted.toml.tmpl"), await readTemplate(packageRoot()));
	await writeFile(join(root, "dist", "worker", "index.js"), "export default { version: '0.4.0' };\n");
	for (const name of ["0001_init.sql", ...PENDING]) await writeFile(join(root, "migrations", name), "SELECT 1;\n");

	state = {
		account_id: "0123456789abcdef0123456789abcdef",
		name: "hookci-hub",
		d1_database_id: "5b0c7f4e-2a1d-4c3b-9e8f-1a2b3c4d5e6f",
		r2_bucket: "hookci-hub-logs",
		base_url: WORKERS_DEV,
		version: "0.3.0",
		steps_done: [...SETUP_STEPS],
	};
	await mkdir(join(dir, "migrations"), { recursive: true });
	await writeFile(join(dir, "migrations", "0001_init.sql"), "SELECT 1;\n");
	installedToml = await wranglerTomlFor(state, root);
	await writeFile(join(dir, "wrangler.toml"), installedToml);
	await saveState(dir, state);
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

function upgradeScript(list = "d1-migrations-list-pending.txt"): FakeScript {
	return [
		{ match: is(...LIST), result: ok(fx[list]) },
		{ match: is(...APPLY), result: ok() },
		{ match: is("deploy"), result: ok(fx["deploy.txt"]) },
	];
}

function infoStub(version: string) {
	const urls: string[] = [];
	const fetchFn = (async (url: string | URL | Request) => {
		urls.push(String(url));
		return Response.json({ name: "hookci-hub", version });
	}) as typeof fetch;
	return { fetchFn, urls };
}

function options(exec: Exec, over: Partial<UpgradeOptions> = {}): UpgradeOptions {
	return { dir, exec, fetchFn: infoStub("0.4.0").fetchFn, prompter: scriptedPrompter({}), root, ...over };
}

async function rejectsWith(p: Promise<unknown>, code: SetupErrorCode): Promise<void> {
	const err = await p.then(
		() => expect.unreachable("expected a SetupError"),
		(e: unknown) => e,
	);
	if (!(err instanceof SetupError)) expect.unreachable(`expected a SetupError, got ${String(err)}`);
	expect(err.code).toBe(code);
}

describe("planUpgrade", () => {
	it("lists the pending migrations and reports an unchanged wrangler.toml", async () => {
		const exec = fakeExec(upgradeScript());
		expect(await planUpgrade(options(exec))).toEqual({ fromVersion: "0.3.0", toVersion: "0.4.0", pendingMigrations: PENDING, configChanged: false });
		expect(exec.calls.map((c) => c.args)).toEqual([LIST]);
	});

	it("reports a changed wrangler.toml when the template changed", async () => {
		await appendFile(join(root, "templates", "wrangler.self-hosted.toml.tmpl"), "\n[observability]\nenabled = true\n");
		const plan = await planUpgrade(options(fakeExec(upgradeScript())));
		expect(plan.configChanged).toBe(true);
		expect(plan.pendingMigrations).toEqual(PENDING);
	});

	it("lists against the new migrations without touching the state dir", async () => {
		let seen: string[] = [];
		let cwd = "";
		const exec: Exec = async (args, opts) => {
			cwd = opts?.cwd ?? "";
			seen = await readdir(join(cwd, "migrations"));
			return ok(fx["d1-migrations-list-none.txt"]);
		};
		expect((await planUpgrade(options(exec))).pendingMigrations).toEqual([]);
		expect(seen.sort()).toEqual(["0001_init.sql", ...PENDING]);
		expect(existsSync(cwd)).toBe(false);
		expect(await readdir(join(dir, "migrations"))).toEqual(["0001_init.sql"]);
	});

	it("needs a setup state", async () => {
		await rm(dir, { recursive: true, force: true });
		await rejectsWith(planUpgrade(options(fakeExec([]))), "not_set_up");
	});
});

describe("runUpgrade", () => {
	it("applies migrations, deploys, checks /v1/info and records the new version", async () => {
		const exec = fakeExec(upgradeScript());
		const info = infoStub("0.4.0");
		const prompter = { ...scriptedPrompter({}), confirm: vi.fn(async () => true) };
		await runUpgrade(options(exec, { fetchFn: info.fetchFn, prompter }));

		expect(prompter.confirm).toHaveBeenCalledWith(CONFIRM, false);
		expect(exec.calls.map((c) => c.args)).toEqual([LIST, APPLY, ["deploy"]]);
		expect(info.urls).toEqual([`${WORKERS_DEV}/v1/info`]);
		expect((await loadState(dir))?.version).toBe("0.4.0");
		expect((await readdir(join(dir, "migrations"))).sort()).toEqual(["0001_init.sql", ...PENDING]);
		expect(await readFile(join(dir, "worker", "index.js"), "utf8")).toContain("0.4.0");
		expect(await readFile(join(dir, "wrangler.toml"), "utf8")).toContain('HUB_VERSION = "0.4.0"');
	});

	it("fails with version_mismatch and keeps the old version when the hub reports another one", async () => {
		const exec = fakeExec(upgradeScript());
		await rejectsWith(runUpgrade(options(exec, { yes: true, fetchFn: infoStub("0.3.0").fetchFn })), "version_mismatch");
		expect(exec.calls.map((c) => c.args)).toEqual([LIST, APPLY, ["deploy"]]);
		expect((await loadState(dir))?.version).toBe("0.3.0");
	});

	it("only lists migrations on --dry-run", async () => {
		const exec = fakeExec(upgradeScript());
		const lines: string[] = [];
		const plan = await runUpgrade(options(exec, { dryRun: true, log: (l) => lines.push(l) }));

		expect(plan.pendingMigrations).toEqual(PENDING);
		expect(exec.calls.map((c) => c.args)).toEqual([LIST]);
		expect(lines).toContain(`D1 migrations to apply: ${PENDING.join(", ")}`);
		expect(await loadState(dir)).toEqual(state);
		expect(await readFile(join(dir, "wrangler.toml"), "utf8")).toBe(installedToml);
		expect(await readdir(join(dir, "migrations"))).toEqual(["0001_init.sql"]);
	});

	it("changes nothing when the confirmation is declined", async () => {
		const exec = fakeExec(upgradeScript());
		await runUpgrade(options(exec, { prompter: scriptedPrompter({ [CONFIRM]: "n" }) }));

		expect(exec.calls.map((c) => c.args)).toEqual([LIST]);
		expect(await loadState(dir)).toEqual(state);
		expect(await readFile(join(dir, "wrangler.toml"), "utf8")).toBe(installedToml);
		expect(existsSync(join(dir, "worker"))).toBe(false);
	});

	it("refuses a downgrade before running wrangler", async () => {
		await saveState(dir, { ...state, version: "0.5.0" });
		const exec = fakeExec([]);
		await rejectsWith(runUpgrade(options(exec, { yes: true })), "downgrade");
		expect(exec.calls).toEqual([]);
	});

	it("needs a setup state that deployed the hub", async () => {
		await rm(dir, { recursive: true, force: true });
		await rejectsWith(runUpgrade(options(fakeExec([]), { yes: true })), "not_set_up");
		await saveState(dir, { account_id: state.account_id, name: "hookci-hub", version: "0.3.0", steps_done: ["preflight", "account"] });
		await rejectsWith(runUpgrade(options(fakeExec([]), { yes: true })), "not_set_up");
	});
});

describe("compareSemver", () => {
	it("orders numerically, a pre-release below its release", () => {
		expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
		expect(compareSemver("0.9.0", "0.10.0")).toBe(-1);
		expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
		expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
		expect(compareSemver("1.2.3", "v1.2.3")).toBe(0);
	});
});
