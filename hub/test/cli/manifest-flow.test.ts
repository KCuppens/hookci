import { createPrivateKey, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ListenFn,
	appJwt,
	awaitManifestCode,
	convertManifestCode,
	githubNewAppUrl,
	manifestFormHtml,
	renderGithubManifest,
	verifyGithubApp,
} from "../../cli/manifest-flow.js";
import { packageRoot } from "../../cli/package.js";
import { scriptedPrompter } from "../../cli/prompts.js";
import { readTemplate } from "../../cli/render.js";
import { SETUP_STEPS, SetupError, type SetupOptions, runSetup } from "../../cli/setup.js";
import { type HubState, STATE_FILE, loadState, saveState } from "../../cli/state.js";
import type { ExecResult } from "../../cli/wrangler.js";
import { type FakeExec, fakeExec } from "./fake-exec.js";
import { type FakeGithub, fakeBrowser, startFakeGithub } from "./fake-github.js";
import { fakeHub } from "./fake-hub.js";

const BASE = "https://zeroci-hub.acme.workers.dev";
const GITHUB_SECRETS = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"];

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const decodeHtml = (s: string) =>
	s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const formValue = (html: string, name: string) => decodeHtml(new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "");
const formAction = (html: string) => decodeHtml(/<form method="post" action="([^"]*)"/.exec(html)?.[1] ?? "");

async function shared(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(packageRoot(), "manifests", "github-app.json"), "utf8"));
}

describe("renderGithubManifest", () => {
	it("points every URL at the hub and copies permissions and events from the shared manifest", async () => {
		const m = renderGithubManifest(BASE, "acme-ci");
		const s = await shared();
		expect(m.name).toBe("acme-ci");
		expect(m.public).toBe(false);
		expect(m.default_permissions).toEqual(s.default_permissions);
		expect(m.default_events).toEqual(s.default_events);
		expect(m.hook_attributes).toEqual({ url: `${BASE}/github/webhook`, active: true });
		const callbackUrls = Array.isArray(m.callback_urls) ? m.callback_urls : [];
		const urls = [m.url, `${BASE}/github/webhook`, m.redirect_url, m.setup_url, ...callbackUrls];
		expect(urls).toHaveLength(7);
		for (const url of urls) expect(url).toMatch(new RegExp(`^${BASE}(/|$)`));
		const paths = (list: unknown) => (Array.isArray(list) ? list : []).map((u) => new URL(String(u)).pathname);
		expect(paths(m.callback_urls)).toEqual(paths(s.callback_urls));
		expect(paths([m.setup_url])).toEqual(paths([s.setup_url]));
		expect(m.setup_on_update).toBe(s.setup_on_update);
		expect(m.request_oauth_on_install).toBe(s.request_oauth_on_install);
		expect(s.setup_on_update).toBe(true);
		expect(s.request_oauth_on_install).toBe(true);
	});
});

describe("manifestFormHtml", () => {
	it("escapes the manifest so it round-trips through the form value, posting to the new-app URL", () => {
		const name = `evil"<>&'name`;
		const manifest = renderGithubManifest(BASE, name);
		const action = githubNewAppUrl({ baseUrl: BASE, name }, "abc123");
		const html = manifestFormHtml(action, manifest, "abc123");
		expect(html).not.toContain(name);
		expect(JSON.parse(formValue(html, "manifest"))).toEqual(manifest);
		expect(formAction(html)).toBe(action);
		expect(action).toBe("https://github.com/settings/apps/new?state=abc123");
	});

	it("uses the organization settings page when an org is given", () => {
		expect(githubNewAppUrl({ baseUrl: BASE, name: "x", org: "acme" }, "s1")).toBe("https://github.com/organizations/acme/settings/apps/new?state=s1");
	});
});

describe("awaitManifestCode", () => {
	it("rejects a wrong state with 400, keeps waiting, and resolves on the right one, on 127.0.0.1 only", async () => {
		const hosts: string[] = [];
		const listen: ListenFn = (server, port, host) => {
			hosts.push(host);
			return new Promise((resolve) => server.listen(port, host, resolve));
		};
		let origin = "";
		let markReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			markReady = resolve;
		});
		const pending = awaitManifestCode({
			state: "good",
			listen,
			page: () => "<form></form>",
			onListening: (o) => {
				origin = o;
				markReady();
			},
		});
		await ready;
		expect(hosts).toEqual(["127.0.0.1"]);
		expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(await (await fetch(`${origin}/`)).text()).toBe("<form></form>");
		expect((await fetch(`${origin}/github/manifest/callback?code=c1&state=wrong`)).status).toBe(400);

		expect((await fetch(`${origin}/github/manifest/callback?code=c2&state=good`)).status).toBe(200);
		const got = await pending;
		expect(got.code).toBe("c2");
		await got.close();
	});

	it("times out with manifest_timeout", async () => {
		await expect(awaitManifestCode({ state: "s", timeoutMs: 50 })).rejects.toMatchObject({ code: "manifest_timeout" });
	});
});

describe("appJwt", () => {
	it("signs an RS256 JWT for the app id, valid for 600 seconds", () => {
		const { publicKey, privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			publicKeyEncoding: { type: "spki", format: "pem" },
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
		});
		const [head = "", payload = "", sig = ""] = appJwt(77, privateKey, 1_700_000_000).split(".");
		const decode = (p: string) => JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
		expect(decode(head)).toEqual({ alg: "RS256", typ: "JWT" });
		const claims = decode(payload);
		expect(claims.iss).toBe(77);
		expect(claims.exp - claims.iat).toBe(600);
		expect(createVerify("RSA-SHA256").update(`${head}.${payload}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
	});
});

describe("convertManifestCode and verifyGithubApp", () => {
	let gh: FakeGithub;
	beforeEach(async () => {
		gh = await startFakeGithub();
	});
	afterEach(async () => {
		await gh.close();
	});

	it("rejects an app whose slug GitHub reports differently", async () => {
		const conv = await convertManifestCode("c", fetch, gh.url);
		expect(gh.calls[0]?.headers.accept).toBe("application/vnd.github+json");
		await expect(verifyGithubApp({ ...conv, slug: "other" }, fetch, gh.url)).rejects.toMatchObject({ code: "github_app_verify_failed" });
	});
});

describe("githubAppStep through runSetup", () => {
	let tmp: string;
	let root: string;
	let dir: string;
	let gh: FakeGithub;
	let deployOut: string;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "zeroci-hub-manifest-"));
		root = join(tmp, "pkg");
		dir = join(tmp, "state");
		await mkdir(join(root, "templates"), { recursive: true });
		await mkdir(join(root, "dist", "worker"), { recursive: true });
		await mkdir(join(root, "migrations"), { recursive: true });
		await mkdir(dir, { recursive: true });
		await writeFile(join(root, "templates", "wrangler.self-hosted.toml.tmpl"), await readTemplate(packageRoot()));
		await writeFile(join(root, "dist", "worker", "index.js"), "export default {};\n");
		await writeFile(join(root, "migrations", "0001_init.sql"), "SELECT 1;\n");
		deployOut = await readFile(join(packageRoot(), "test", "cli", "fixtures", "deploy.txt"), "utf8");
		const before: HubState = {
			account_id: "0123456789abcdef0123456789abcdef",
			name: "zeroci-hub",
			d1_database_id: "5b0c7f4e-2a1d-4c3b-9e8f-1a2b3c4d5e6f",
			r2_bucket: "zeroci-hub-logs",
			base_url: BASE,
			version: "0.0.0",
			steps_done: SETUP_STEPS.slice(0, SETUP_STEPS.indexOf("github_app")),
		};
		await saveState(dir, before);
		gh = await startFakeGithub();
	});

	afterEach(async () => {
		await gh.close();
		await rm(tmp, { recursive: true, force: true });
	});

	const wrangler = (): FakeExec =>
		fakeExec([
			{ match: (a) => a[0] === "secret" && a[1] === "put", result: ok("✨ Success! Uploaded secret\n") },
			{ match: (a) => a[0] === "deploy", result: ok(deployOut) },
		]);

	/** Runs setup from the GitHub App step on, without Slack, against a hub that verifies at once. */
	function options(exec: FakeExec, over: Partial<SetupOptions>): SetupOptions {
		return { dir, root, yes: true, noSlack: true, exec, prompter: scriptedPrompter({}), fetchFn: fakeHub().fetchFn, githubApiBase: gh.url, ...over };
	}

	it("stores the app's credentials on stdin, redeploys with its slug and prints the install link", async () => {
		const exec = wrangler();
		const log: string[] = [];
		const opened: string[] = [];
		const state = await runSetup(options(exec, { log: (l) => log.push(l), openBrowser: fakeBrowser("code-1", opened) }));

		const puts = exec.calls.filter((c) => c.args[0] === "secret");
		expect(puts.map((c) => c.args)).toEqual(GITHUB_SECRETS.map((n) => ["secret", "put", n]));
		const values = puts.map((c) => c.stdin ?? "");
		expect(values[0]).toBe("424242");
		expect(values[1]).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
		expect(createPrivateKey(values[1] ?? "").asymmetricKeyType).toBe("rsa");
		expect(values.slice(2)).toEqual(["whsec-fake-0f9e8d7c", "Iv1.fakeclientid0001", "fake-client-secret-5a4b3c2d1e"]);
		for (const v of values) {
			expect(exec.calls.some((c) => c.args.some((a) => a.includes(v)))).toBe(false);
			expect(log.some((l) => l.includes(v))).toBe(false);
		}

		const appCalls = gh.calls.filter((c) => c.method === "GET" && c.path === "/app");
		expect(appCalls).toHaveLength(1);
		expect(appCalls[0]?.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
		expect(gh.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/app-manifests/code-1/conversions"]);

		const stateFile = await readFile(join(dir, STATE_FILE), "utf8");
		expect(stateFile).not.toContain("PRIVATE KEY");
		expect(state).toMatchObject({ github_app_id: 424242, github_app_slug: "acme-zeroci", steps_done: SETUP_STEPS.filter((s) => s !== "slack_app") });
		expect(await loadState(dir)).toEqual(state);

		const lastPut = exec.calls.map((c) => c.args[0]).lastIndexOf("secret");
		expect(exec.calls.findIndex((c) => c.args[0] === "deploy")).toBeGreaterThan(lastPut);
		const toml = parse(await readFile(join(dir, "wrangler.toml"), "utf8")) as { vars: Record<string, string> };
		expect(toml.vars.GITHUB_APP_SLUG).toBe("acme-zeroci");

		expect(opened).toHaveLength(1);
		expect(log).toContain(`Open ${opened[0]} in your browser to create the GitHub App`);
		expect(log).toContain("Install the app: https://github.com/apps/acme-zeroci/installations/new");
	});

	it("puts no secret when the conversion fails", async () => {
		const exec = wrangler();
		const err = await runSetup(options(exec, { openBrowser: fakeBrowser("bad") })).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SetupError);
		expect((err as SetupError).code).toBe("manifest_conversion_failed");
		expect((err as SetupError).message).toContain("404");
		expect(exec.calls).toEqual([]);
	});

	it("puts no secret when GitHub rejects the app JWT", async () => {
		gh.nextConversion = { pem: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
		const exec = wrangler();
		const err = await runSetup(options(exec, { openBrowser: fakeBrowser("code-2") })).catch((e: unknown) => e);
		expect((err as SetupError).code).toBe("github_app_verify_failed");
		expect(exec.calls).toEqual([]);
	});

	it("keeps the new app's id but not its key when a secret put fails, and refuses to create a second app", async () => {
		const failing = fakeExec([
			{ match: (a) => a.join(" ") === "secret put GITHUB_WEBHOOK_SECRET", result: { code: 1, stdout: "", stderr: "Authentication error" } },
			{ match: (a) => a[0] === "secret" && a[1] === "put", result: ok("✨ Success! Uploaded secret\n") },
		]);
		const first = await runSetup(options(failing, { openBrowser: fakeBrowser("code-4") })).catch((e: unknown) => e);
		expect((first as SetupError).code).toBe("wrangler_failed");
		expect(await loadState(dir)).toMatchObject({ github_app_id: 424242, github_app_slug: "acme-zeroci", github_app_html_url: "https://github.com/apps/acme-zeroci" });
		expect(await readFile(join(dir, STATE_FILE), "utf8")).not.toContain("PRIVATE KEY");

		const callsBefore = gh.calls.length;
		const opened: string[] = [];
		const exec = fakeExec([]);
		const second = await runSetup(options(exec, { openBrowser: async (url) => void opened.push(url) })).catch((e: unknown) => e);
		expect(second).toBeInstanceOf(SetupError);
		expect((second as SetupError).code).toBe("github_app_incomplete");
		expect((second as SetupError).message).toContain("GitHub App 424242 (https://github.com/apps/acme-zeroci)");
		expect((second as SetupError).hint).toContain("Delete that app");
		expect(gh.calls).toHaveLength(callsBefore);
		expect(opened).toEqual([]);
		expect(exec.calls).toEqual([]);
	});

	it("resumes at the redeploy when the deploy failed after every secret was stored", async () => {
		const failingDeploy = fakeExec([
			{ match: (a) => a[0] === "secret" && a[1] === "put", result: ok("✨ Success! Uploaded secret\n") },
			{ match: (a) => a[0] === "deploy", result: { code: 1, stdout: "", stderr: "Authentication error" } },
		]);
		const first = await runSetup(options(failingDeploy, { openBrowser: fakeBrowser("code-5") })).catch((e: unknown) => e);
		expect(first).toBeInstanceOf(SetupError);
		expect(failingDeploy.calls.filter((c) => c.args[0] === "secret").map((c) => c.args[2])).toEqual(GITHUB_SECRETS);
		expect(await loadState(dir)).toMatchObject({ github_app_id: 424242, github_app_secrets_stored: true });
		expect((await loadState(dir))?.steps_done).not.toContain("github_app");

		const callsBefore = gh.calls.length;
		const exec = wrangler();
		const log: string[] = [];
		const opened: string[] = [];
		const state = await runSetup(options(exec, { log: (l) => log.push(l), openBrowser: async (url) => void opened.push(url) }));
		expect(gh.calls).toHaveLength(callsBefore);
		expect(opened).toEqual([]);
		expect(exec.calls.filter((c) => c.args[0] === "secret")).toEqual([]);
		expect(exec.calls.filter((c) => c.args[0] === "deploy")).toHaveLength(1);
		expect(state.steps_done).toContain("github_app");
		expect(await loadState(dir)).toEqual(state);
		const toml = parse(await readFile(join(dir, "wrangler.toml"), "utf8")) as { vars: Record<string, string> };
		expect(toml.vars.GITHUB_APP_SLUG).toBe("acme-zeroci");
		expect(log).toContain("Install the app: https://github.com/apps/acme-zeroci/installations/new");
	});

	it("does nothing on a second run once the app is registered", async () => {
		await runSetup(options(wrangler(), { openBrowser: fakeBrowser("code-3") }));
		const callsBefore = gh.calls.length;
		const exec = fakeExec([]);
		const opened: string[] = [];
		await runSetup(options(exec, { openBrowser: async (url) => void opened.push(url) }));
		expect(gh.calls).toHaveLength(callsBefore);
		expect(opened).toEqual([]);
		expect(exec.calls).toEqual([]);
	});
});
