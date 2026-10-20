import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { packageRoot } from "../../cli/package.js";
import { type Prompter, scriptedPrompter } from "../../cli/prompts.js";
import { readTemplate } from "../../cli/render.js";
import { SETUP_STEPS, SetupError, type SetupOptions, applyLifecycle, preflight, putSecrets, resolveAccount, runSetup } from "../../cli/setup.js";
import { setupSummary } from "../../cli/slack-step.js";
import { type HubState, STATE_FILE, loadState } from "../../cli/state.js";
import type { Exec, ExecResult } from "../../cli/wrangler.js";
import { type FakeExec, type FakeScript, fakeExec } from "./fake-exec.js";
import { type FakeGithub, fakeBrowser, startFakeGithub } from "./fake-github.js";
import { SLACK_ANSWERS, fakeHub } from "./fake-hub.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
const CREATED_DB = "5b0c7f4e-2a1d-4c3b-9e8f-1a2b3c4d5e6f";
const EXISTING_DB = "1f2e3d4c-5b6a-4789-8a7b-6c5d4e3f2a1b";
const WORKERS_DEV = "https://zeroci-hub.acme.workers.dev";
const LIFECYCLE = ["r2", "bucket", "lifecycle", "add", "zeroci-hub-logs", "zeroci-log-retention", "--expire-days", "14", "--prefix", "logs/"];
const ACCOUNT_QUESTION = `Cloudflare account: 1) Acme Inc (${ACCOUNT}), 2) Acme Labs (${OTHER_ACCOUNT})`;
const DOMAIN_QUESTION = "Custom domain (empty for workers.dev)";
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;

interface Toml {
	name: string;
	account_id: string;
	routes?: { pattern: string; custom_domain: boolean }[];
	vars: Record<string, string>;
	d1_databases: { database_name: string; database_id: string }[];
	r2_buckets: { bucket_name: string }[];
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const is =
	(...prefix: string[]) =>
	(args: string[]) =>
		prefix.every((p, i) => args[i] === p);
const GITHUB_APP_COMMANDS = [
	["secret", "put", "GITHUB_APP_ID"],
	["secret", "put", "GITHUB_APP_PRIVATE_KEY"],
	["secret", "put", "GITHUB_WEBHOOK_SECRET"],
	["secret", "put", "GITHUB_CLIENT_ID"],
	["secret", "put", "GITHUB_CLIENT_SECRET"],
	["deploy"],
];
const SLACK_APP_COMMANDS = [
	["secret", "put", "SLACK_SIGNING_SECRET"],
	["secret", "put", "SLACK_CLIENT_ID"],
	["secret", "put", "SLACK_CLIENT_SECRET"],
];

const fx: Record<string, string> = {};
let tmp: string;
let root: string;
let dir: string;
let gh: FakeGithub;

beforeAll(async () => {
	for (const name of ["whoami-one.txt", "whoami-two.txt", "d1-create.txt", "d1-list.json", "r2-list.txt", "deploy.txt"]) {
		fx[name] = await readFile(join(packageRoot(), "test", "cli", "fixtures", name), "utf8");
	}
});

beforeEach(async () => {
	vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", undefined);
	vi.stubEnv("CLOUDFLARE_API_TOKEN", undefined);
	tmp = await mkdtemp(join(tmpdir(), "zeroci-hub-setup-"));
	root = join(tmp, "pkg");
	dir = join(tmp, "state");
	await mkdir(join(root, "templates"), { recursive: true });
	await mkdir(join(root, "dist", "worker"), { recursive: true });
	await mkdir(join(root, "migrations"), { recursive: true });
	await writeFile(join(root, "templates", "wrangler.self-hosted.toml.tmpl"), await readTemplate(packageRoot()));
	await writeFile(join(root, "dist", "worker", "index.js"), "export default {};\n");
	await writeFile(join(root, "migrations", "0001_init.sql"), "SELECT 1;\n");
	gh = await startFakeGithub();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(tmp, { recursive: true, force: true });
	await gh.close();
});

/**
 * Setup options whose GitHub App step runs against the fake GitHub with a
 * scripted browser, whose Slack step gets scripted credentials and whose
 * deployed hub answers /v1/info at once.
 */
function options(exec: Exec, over: Partial<SetupOptions> = {}): SetupOptions {
	return {
		dir,
		yes: true,
		exec,
		prompter: scriptedPrompter(SLACK_ANSWERS),
		fetchFn: fakeHub().fetchFn,
		sleep: async () => {},
		githubApiBase: gh.url,
		openBrowser: fakeBrowser("code"),
		root,
		...over,
	};
}

/** wrangler on an account with no hub resources yet. */
function freshAccount(over: FakeScript = []): FakeScript {
	return [
		...over,
		{ match: is("whoami"), result: ok(fx["whoami-one.txt"]) },
		{ match: is("d1", "list"), result: ok("[]\n") },
		{ match: is("d1", "create"), result: ok(fx["d1-create.txt"]) },
		{ match: is("r2", "bucket", "list"), result: ok("Listing buckets...\n") },
		{ match: is("r2", "bucket", "create"), result: ok("Creating bucket 'zeroci-hub-logs'...\n✅ Created bucket 'zeroci-hub-logs'\n") },
		{ match: is("r2", "bucket", "lifecycle", "add"), result: ok("✨ Added lifecycle rule 'zeroci-log-retention' to bucket 'zeroci-hub-logs'.\n") },
		{ match: is("d1", "migrations", "apply"), result: ok("✅ Migrations applied\n") },
		{ match: is("deploy"), result: ok(fx["deploy.txt"]) },
		{ match: is("secret", "put"), result: ok("✨ Success! Uploaded secret\n") },
	];
}

const commands = (exec: FakeExec) => exec.calls.map((c) => c.args);

async function setupError(promise: Promise<unknown>): Promise<SetupError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof SetupError) return err;
		throw err;
	}
	return expect.unreachable("setup did not fail");
}

async function renderedToml(): Promise<Toml> {
	// smol-toml returns an untyped table; the assertions check every field they read.
	return parse(await readFile(join(dir, "wrangler.toml"), "utf8")) as unknown as Toml;
}

describe("runSetup", () => {
	it("fresh run: creates everything in order and records it", async () => {
		const exec = fakeExec(freshAccount());
		const log: string[] = [];
		const state = await runSetup(options(exec, { log: (line) => log.push(line) }));

		expect(commands(exec)).toEqual([
			["whoami"],
			["d1", "list", "--json"],
			["d1", "create", "zeroci-hub-db"],
			["r2", "bucket", "list"],
			["r2", "bucket", "create", "zeroci-hub-logs"],
			LIFECYCLE,
			["d1", "migrations", "apply", "zeroci-hub-db", "--remote"],
			["deploy"],
			["deploy"],
			["secret", "put", "TOKEN_ENC_KEYS"],
			["secret", "put", "STATE_SIGNING_KEY"],
			["secret", "put", "LOG_SIGNING_KEY"],
			...GITHUB_APP_COMMANDS,
			...SLACK_APP_COMMANDS,
		]);
		expect(state).toMatchObject({
			account_id: ACCOUNT,
			name: "zeroci-hub",
			d1_database_id: CREATED_DB,
			r2_bucket: "zeroci-hub-logs",
			base_url: WORKERS_DEV,
			slack_configured: true,
			hub_version_seen: "0.3.0",
			steps_done: [...SETUP_STEPS],
		});
		expect(await loadState(dir)).toEqual(state);
		// One line per step, the GitHub App step's browser URL and install link,
		// the Slack step's manifest link, instructions and install link, the
		// verified version, then the summary.
		expect(log).toHaveLength(SETUP_STEPS.length + 7);
		expect(log[log.length - 1]).toBe(setupSummary(state));

		const toml = await renderedToml();
		expect(toml.name).toBe("zeroci-hub");
		expect(toml.account_id).toBe(ACCOUNT);
		expect(toml.d1_databases[0]?.database_id).toBe(CREATED_DB);
		expect(toml.r2_buckets[0]?.bucket_name).toBe("zeroci-hub-logs");
		expect(toml.vars.HUB_ORIGIN).toBe(WORKERS_DEV);
		expect(existsSync(join(dir, "worker", "index.js"))).toBe(true);
		expect(existsSync(join(dir, "migrations", "0001_init.sql"))).toBe(true);
	});

	it("idempotent: a second run issues no wrangler commands and prints the summary again", async () => {
		const first = await runSetup(options(fakeExec(freshAccount())));
		const exec = fakeExec([]);
		const log: string[] = [];
		const second = await runSetup(options(exec, { log: (line) => log.push(line) }));
		expect(exec.calls).toEqual([]);
		expect(second).toEqual(first);
		const doneEarlier = SETUP_STEPS.map((_, i) => expect.stringMatching(new RegExp(`^\\[${i + 1}/${SETUP_STEPS.length}\\] .*: done earlier$`)));
		expect(log).toEqual([...doneEarlier, setupSummary(first)]);
	});

	it("resume: a failed migration keeps earlier steps and the rerun starts there", async () => {
		const stderr = Array.from({ length: 30 }, (_, i) => `stderr line ${i + 1}`).join("\n");
		const failing = fakeExec(freshAccount([{ match: is("d1", "migrations", "apply"), result: { code: 1, stdout: "", stderr } }]));
		const err = await setupError(runSetup(options(failing)));
		expect(err.code).toBe("wrangler_failed");
		expect(err.message).toBe("wrangler d1 migrations apply zeroci-hub-db --remote exited with code 1");
		expect(err.detail.split("\n")).toEqual(Array.from({ length: 20 }, (_, i) => `stderr line ${i + 11}`));
		expect((await loadState(dir))?.steps_done).toEqual(SETUP_STEPS.slice(0, SETUP_STEPS.indexOf("migrate")));

		const exec = fakeExec(freshAccount());
		const state = await runSetup(options(exec));
		expect(commands(exec)[0]).toEqual(["d1", "migrations", "apply", "zeroci-hub-db", "--remote"]);
		expect(commands(exec).filter((a) => a.includes("create") || a[0] === "whoami")).toEqual([]);
		expect(state.d1_database_id).toBe(CREATED_DB);
		expect(state.steps_done).toEqual([...SETUP_STEPS]);
	});

	it("existing resources: reuses the database and bucket without creating them", async () => {
		const exec = fakeExec(
			freshAccount([
				{ match: is("d1", "list"), result: ok(fx["d1-list.json"]) },
				{ match: is("r2", "bucket", "list"), result: ok(fx["r2-list.txt"]) },
			]),
		);
		const state = await runSetup(options(exec));
		expect(commands(exec).filter((a) => a.includes("create"))).toEqual([]);
		expect(state.d1_database_id).toBe(EXISTING_DB);
		expect(state.r2_bucket).toBe("zeroci-hub-logs");
		expect((await renderedToml()).d1_databases[0]?.database_id).toBe(EXISTING_DB);
	});

	it("custom domain: renders the route and deploys once with the domain as base URL", async () => {
		const exec = fakeExec(freshAccount());
		const prompter = scriptedPrompter({ ...SLACK_ANSWERS, "Hub name": "acme-ci", [DOMAIN_QUESTION]: "ci.acme.dev" });
		const state = await runSetup(options(exec, { yes: false, prompter }));
		expect(commands(exec).filter((a) => a[0] === "deploy")).toEqual([["deploy"], ["deploy"]]);
		expect(commands(exec)).toContainEqual(["d1", "create", "acme-ci-db"]);
		expect(commands(exec)).toContainEqual(["r2", "bucket", "create", "acme-ci-logs"]);
		expect(state).toMatchObject({ name: "acme-ci", custom_domain: "ci.acme.dev", base_url: "https://ci.acme.dev" });
		const toml = await renderedToml();
		expect(toml.vars.HUB_ORIGIN).toBe("https://ci.acme.dev");
		expect(toml.routes).toEqual([{ pattern: "ci.acme.dev", custom_domain: true }]);
	});

	it("--force-render: renders and deploys again on a finished setup", async () => {
		await runSetup(options(fakeExec(freshAccount())));
		await writeFile(join(dir, "wrangler.toml"), "stale\n");
		const exec = fakeExec(freshAccount());
		await runSetup(options(exec, { forceRender: true }));
		expect(commands(exec)).toEqual([["deploy"]]);
		expect((await renderedToml()).vars.HUB_ORIGIN).toBe(WORKERS_DEV);
	});
});

describe("secrets", () => {
	it("passes each generated value on stdin only and never writes it down", async () => {
		const exec = fakeExec(freshAccount());
		const state = await runSetup(options(exec));
		const puts = exec.calls.filter((c) => c.args[0] === "secret" && !/^(GITHUB|SLACK)_/.test(c.args[2] ?? ""));
		expect(puts.map((c) => c.args[2])).toEqual(["TOKEN_ENC_KEYS", "STATE_SIGNING_KEY", "LOG_SIGNING_KEY"]);

		const [encKeys = "", stateKey = "", logKey = ""] = puts.map((c) => c.stdin ?? "");
		const encKeysJson = JSON.parse(encKeys);
		expect(encKeysJson).toEqual({ current: 1, keys: { "1": expect.stringMatching(BASE64_KEY) } });
		expect(stateKey).toMatch(BASE64_KEY);
		expect(logKey).toMatch(BASE64_KEY);

		const values: string[] = [encKeysJson.keys["1"], stateKey, logKey];
		expect(new Set(values).size).toBe(3);
		const stateFile = await readFile(join(dir, STATE_FILE), "utf8");
		for (const value of values) {
			expect(exec.calls.some((c) => c.args.some((a) => a.includes(value)))).toBe(false);
			expect(stateFile).not.toContain(value);
		}
		expect(state.secrets_set).toEqual(["TOKEN_ENC_KEYS", "STATE_SIGNING_KEY", "LOG_SIGNING_KEY"]);
	});

	it("uses the injected random source and skips secrets already stored", async () => {
		const exec = fakeExec(freshAccount());
		const s: HubState = { account_id: ACCOUNT, version: "0.0.0", steps_done: [], secrets_set: ["TOKEN_ENC_KEYS"] };
		await mkdir(dir, { recursive: true });
		const next = await putSecrets(options(exec, { randomBytes: (n) => new Uint8Array(n).fill(7) }), s);
		expect(exec.calls).toEqual([
			{ args: ["secret", "put", "STATE_SIGNING_KEY"], stdin: Buffer.alloc(32, 7).toString("base64") },
			{ args: ["secret", "put", "LOG_SIGNING_KEY"], stdin: Buffer.alloc(32, 7).toString("base64") },
		]);
		expect(next.secrets_set).toEqual(["TOKEN_ENC_KEYS", "STATE_SIGNING_KEY", "LOG_SIGNING_KEY"]);
		expect((await loadState(dir))?.secrets_set).toEqual(next.secrets_set);
	});
});

describe("lifecycle", () => {
	const s: HubState = { account_id: ACCOUNT, name: "zeroci-hub", r2_bucket: "zeroci-hub-logs", version: "0.0.0", steps_done: [] };

	it("expires logs/ after 14 days", async () => {
		const exec = fakeExec(freshAccount());
		await applyLifecycle(options(exec), s);
		expect(commands(exec)).toEqual([LIFECYCLE]);
	});

	it("counts an existing rule as success and fails on other errors", async () => {
		const exists = fakeExec([{ match: is("r2"), result: { code: 1, stdout: "", stderr: "✘ [ERROR] A lifecycle rule with ID zeroci-log-retention already exists" } }]);
		await expect(applyLifecycle(options(exists), s)).resolves.toEqual(s);

		const denied = fakeExec([{ match: is("r2"), result: { code: 1, stdout: "", stderr: "✘ [ERROR] Authentication error [code: 10000]" } }]);
		const err = await setupError(applyLifecycle(options(denied), s));
		expect(err.code).toBe("wrangler_failed");
		expect(err.detail).toBe("✘ [ERROR] Authentication error [code: 10000]");
	});
});

describe("account", () => {
	it("prompts for the account when wrangler can use several", async () => {
		const exec = fakeExec([{ match: is("whoami"), result: ok(fx["whoami-two.txt"]) }]);
		const prompter: Prompter = scriptedPrompter({ [ACCOUNT_QUESTION]: "2", [DOMAIN_QUESTION]: "" });
		const s = await resolveAccount(options(exec, { yes: false, prompter }), { account_id: "", version: "0.0.0", steps_done: [] });
		expect(s).toEqual({ account_id: OTHER_ACCOUNT, name: "zeroci-hub", version: "0.0.0", steps_done: [] });
	});

	it("takes CLOUDFLARE_ACCOUNT_ID without asking wrangler", async () => {
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", OTHER_ACCOUNT);
		const exec = fakeExec([]);
		const s = await resolveAccount(options(exec), { account_id: "", version: "0.0.0", steps_done: [] });
		expect(s.account_id).toBe(OTHER_ACCOUNT);
		expect(exec.calls).toEqual([]);
	});
});

describe("errors", () => {
	it("refuses Node 18 before calling wrangler", async () => {
		const versions = Object.getOwnPropertyDescriptor(process, "versions");
		if (!versions) expect.unreachable("process.versions has no property descriptor");
		Object.defineProperty(process, "versions", { ...versions, value: { ...process.versions, node: "18.19.0" } });
		try {
			const exec = fakeExec([]);
			expect((await setupError(preflight(options(exec)))).code).toBe("node_too_old");
			expect(exec.calls).toEqual([]);
		} finally {
			Object.defineProperty(process, "versions", versions);
		}
	});

	it("asks for wrangler login when not authenticated", async () => {
		const notAuthed = () => fakeExec([{ match: is("whoami"), result: ok("Getting User settings...\nYou are not authenticated. Please run `wrangler login`.\n") }]);
		const err = await setupError(preflight(options(notAuthed())));
		expect(err.code).toBe("not_logged_in");
		expect(err.message).toBe("run: npx wrangler login");

		vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
		await expect(preflight(options(notAuthed()))).resolves.toBeUndefined();
	});

	it("refuses to guess between two accounts under --yes", async () => {
		const exec = fakeExec([{ match: is("whoami"), result: ok(fx["whoami-two.txt"]) }]);
		const err = await setupError(runSetup(options(exec)));
		expect(err.code).toBe("multiple_accounts");
		expect((await loadState(dir))?.steps_done).toEqual(["preflight"]);
	});

	it("rejects an invalid hub name", async () => {
		const exec = fakeExec([{ match: is("whoami"), result: ok(fx["whoami-one.txt"]) }]);
		const prompter = scriptedPrompter({ "Hub name": "Zeroci_Hub" });
		const err = await setupError(runSetup(options(exec, { yes: false, prompter })));
		expect(err.code).toBe("bad_name");
		expect(err.hint).toContain("lowercase");
	});
});
