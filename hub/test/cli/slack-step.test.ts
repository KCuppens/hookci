import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import type { SetupContext } from "../../cli/manifest-flow.js";
import { packageRoot } from "../../cli/package.js";
import { scriptedPrompter } from "../../cli/prompts.js";
import { SETUP_STEPS, SetupError, type SetupOptions, runSetup } from "../../cli/setup.js";
import {
	NO_SLACK_REMINDER,
	SLACK_BOT_SCOPES,
	renderSlackManifest,
	setupSummary,
	slackAppStep,
	slackNewAppUrl,
	verifyStep,
} from "../../cli/slack-step.js";
import { type HubState, loadState, saveState } from "../../cli/state.js";
import type { ExecResult } from "../../cli/wrangler.js";
import { type FakeExec, fakeExec } from "./fake-exec.js";
import { type InfoReply, SLACK_ANSWERS, fakeHub, hubInfo } from "./fake-hub.js";

const BASE = "https://hub.example.com";
const SLACK_SECRETS = ["SLACK_SIGNING_SECRET", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"];

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const wrangler = (): FakeExec => fakeExec([{ match: (a) => a[0] === "secret" && a[1] === "put", result: ok("✨ Success! Uploaded secret\n") }]);

/** Every http(s) URL anywhere in `value`. */
function urlsIn(value: unknown): string[] {
	if (typeof value === "string") return /^https?:\/\//.test(value) ? [value] : [];
	if (Array.isArray(value)) return value.flatMap(urlsIn);
	if (value && typeof value === "object") return Object.values(value).flatMap(urlsIn);
	return [];
}

async function setupError(promise: Promise<unknown>): Promise<SetupError> {
	const err = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	if (!(err instanceof SetupError)) throw new Error(`expected a SetupError, got ${String(err)}`);
	return err;
}

type Refusal = Mock<(q: string) => Promise<never>>;

/** A prompter that fails the test when asked anything. */
function silentPrompter(): { ask: Refusal; secret: Refusal; confirm: Refusal } {
	const refuse: Refusal = vi.fn(async (q: string): Promise<never> => {
		throw new Error(`unexpected question "${q}"`);
	});
	return { ask: refuse, secret: refuse, confirm: refuse };
}

let tmp: string;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "hookci-hub-slack-"));
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

function registered(over: Partial<HubState> = {}): HubState {
	return {
		account_id: "0123456789abcdef0123456789abcdef",
		name: "acme-ci",
		base_url: BASE,
		github_app_id: 424242,
		github_app_slug: "acme-hookci",
		version: "0.3.0",
		steps_done: SETUP_STEPS.slice(0, SETUP_STEPS.indexOf("slack_app")),
		...over,
	};
}

function context(over: Partial<SetupOptions>, state: HubState, exec: FakeExec, log: string[]): SetupContext {
	const options: SetupOptions = { dir: tmp, yes: true, exec, prompter: scriptedPrompter(SLACK_ANSWERS), fetchFn: fakeHub().fetchFn, sleep: async () => {}, ...over };
	return { options, state, exec, log: (line) => log.push(line) };
}

describe("renderSlackManifest", () => {
	it("puts every URL on the hub's base URL, on a route the hub serves", async () => {
		const manifest = renderSlackManifest(`${BASE}/`, "acme-ci");
		const urls = urlsIn(manifest);
		expect(urls).toHaveLength(4);
		for (const url of urls) expect(url.startsWith(`${BASE}/`)).toBe(true);

		const app = await readFile(join(packageRoot(), "src", "app.ts"), "utf8");
		const routes = [...app.matchAll(/app\.(?:get|post)\("([^"]+)"/g)].map((m) => m[1]);
		expect(urls.map((url) => new URL(url).pathname).sort()).toEqual(["/slack/commands", "/slack/events", "/slack/interactive", "/slack/oauth/callback"]);
		for (const url of urls) expect(routes).toContain(new URL(url).pathname);

		expect(manifest.display_information.name).toBe("acme-ci");
		expect(manifest.features.bot_user.display_name).toBe("acme-ci");
	});

	it("asks for exactly the seven bot scopes", () => {
		const scopes = renderSlackManifest(BASE, "acme-ci").oauth_config.scopes.bot;
		expect(scopes).toEqual(["chat:write", "commands", "channels:read", "groups:read", "im:write", "users:read", "users:read.email"]);
		expect(scopes).toEqual([...SLACK_BOT_SCOPES]);
		expect(scopes).not.toContain("chat:write.public");
	});

	it("rejects a manifest with an extra scope", async () => {
		const shipped = parse(await readFile(join(packageRoot(), "manifests", "slack-app.yml"), "utf8")) as { oauth_config: { scopes: { bot: string[] } } };
		shipped.oauth_config.scopes.bot.push("chat:write.public");
		await mkdir(join(tmp, "manifests"));
		await writeFile(join(tmp, "manifests", "slack-app.yml"), stringify(shipped));
		const err = await setupError(Promise.resolve().then(() => renderSlackManifest(BASE, "acme-ci", tmp)));
		expect(err.code).toBe("bad_manifest");
		expect(err.message).toContain("chat:write.public");
	});

	it("carries the manifest whole in the create-app link", () => {
		const manifest = renderSlackManifest(BASE, "acme-ci");
		const url = new URL(slackNewAppUrl(manifest));
		expect(`${url.origin}${url.pathname}`).toBe("https://api.slack.com/apps");
		expect(url.searchParams.get("new_app")).toBe("1");
		expect(JSON.parse(url.searchParams.get("manifest_json") ?? "")).toEqual(manifest);
	});
});

describe("slackAppStep", () => {
	it("stores the three credentials on stdin only and prints the Add to Slack link", async () => {
		const exec = wrangler();
		const log: string[] = [];
		const prompter = scriptedPrompter({ "Slack Signing Secret": "abc123", "Slack Client ID": "123.456", "Slack Client Secret": "sec" });
		const state = await slackAppStep(context({ prompter }, registered(), exec, log));

		expect(exec.calls).toEqual([
			{ args: ["secret", "put", "SLACK_SIGNING_SECRET"], stdin: "abc123" },
			{ args: ["secret", "put", "SLACK_CLIENT_ID"], stdin: "123.456" },
			{ args: ["secret", "put", "SLACK_CLIENT_SECRET"], stdin: "sec" },
		]);
		for (const value of ["abc123", "sec"]) expect(log.some((line) => line.includes(value))).toBe(false);
		expect(state.slack_configured).toBe(true);
		expect(log[0]).toMatch(/^Create the Slack App: https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
		expect(log).toContain(`Add to Slack: ${BASE}/slack/install`);
	});

	it("asks again for a Client ID that is not two dot-separated numbers", async () => {
		const exec = wrangler();
		const log: string[] = [];
		const prompter = scriptedPrompter({ ...SLACK_ANSWERS, "Slack Client ID": ["abc", "123.456"] });
		await slackAppStep(context({ prompter }, registered(), exec, log));
		expect(exec.calls.find((c) => c.args[2] === "SLACK_CLIENT_ID")?.stdin).toBe("123.456");
		expect(log).toContain('The Slack Client ID "abc" does not look like 1234567890.1234567890.');
	});

	it("gives up after three empty answers and stores nothing", async () => {
		const exec = wrangler();
		const prompter = scriptedPrompter({ ...SLACK_ANSWERS, "Slack Signing Secret": ["", " ", ""] });
		const err = await setupError(slackAppStep(context({ prompter }, registered(), exec, [])));
		expect(err.code).toBe("missing_input");
		expect(err.message).toBe("no Slack Signing Secret after 3 tries");
		expect(exec.calls).toEqual([]);
	});
});

describe("--no-slack", () => {
	it("skips the Slack step without prompting or storing, leaves it undone and says so in the summary", async () => {
		await saveState(tmp, registered({ steps_done: SETUP_STEPS.slice(0, SETUP_STEPS.indexOf("slack_app")) }));
		const exec = fakeExec([]);
		const prompter = silentPrompter();
		const log: string[] = [];
		const state = await runSetup({ dir: tmp, yes: true, noSlack: true, exec, prompter, fetchFn: fakeHub().fetchFn, sleep: async () => {}, log: (l) => log.push(l) });

		expect(prompter.ask).not.toHaveBeenCalled();
		expect(exec.calls).toEqual([]);
		expect(state.steps_done).toEqual(SETUP_STEPS.filter((s) => s !== "slack_app"));
		expect((await loadState(tmp))?.steps_done).toEqual(state.steps_done);
		expect(log).toContain(NO_SLACK_REMINDER);
		expect(log[log.length - 1]).toBe(setupSummary(state));
		expect(setupSummary(state)).toContain(NO_SLACK_REMINDER);
	});
});

describe("verifyStep", () => {
	async function verify(replies: InfoReply[], state = registered()) {
		const hub = fakeHub(replies, async () => {
			throw new Error("only /v1/info is fetched");
		});
		const sleep = vi.fn(async (_ms: number) => {});
		const log: string[] = [];
		const result = verifyStep(context({ fetchFn: hub.fetchFn, sleep }, state, wrangler(), log));
		return { result, hub, sleep, log };
	}

	it("records the version a self-hosted hub with this GitHub App reports", async () => {
		const { result, hub, sleep } = await verify([{ status: 200, body: hubInfo({ version: "0.3.1" }) }]);
		expect((await result).hub_version_seen).toBe("0.3.1");
		expect(hub.infoUrls).toEqual([`${BASE}/v1/info`]);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("rejects a hub in shared mode", async () => {
		const { result } = await verify([{ status: 200, body: hubInfo({ mode: "shared" }) }]);
		const err = await setupError(result);
		expect(err.code).toBe("verify_failed");
		expect(err.message).toBe(`${BASE}/v1/info reports mode "shared", not "self_hosted"`);
	});

	it("rejects a hub with another GitHub App", async () => {
		const { result } = await verify([{ status: 200, body: hubInfo({ github_app: { slug: "other-app" } }) }]);
		const err = await setupError(result);
		expect(err.code).toBe("verify_failed");
		expect(err.message).toBe(`${BASE}/v1/info reports GitHub App "other-app", not "acme-hookci"`);
	});

	it("waits out a deploy that is still propagating", async () => {
		const { result, hub, sleep } = await verify([{ status: 503 }, { status: 503 }, { status: 200, body: hubInfo() }]);
		expect((await result).hub_version_seen).toBe("0.3.0");
		expect(hub.infoUrls).toHaveLength(3);
		expect(sleep.mock.calls).toEqual([[2000], [2000]]);
	});

	it("gives up after five failed attempts", async () => {
		const { result, hub, sleep } = await verify([{ networkError: "fetch failed" }]);
		const err = await setupError(result);
		expect(err.code).toBe("verify_failed");
		expect(err.message).toBe(`GET ${BASE}/v1/info failed 5 times, last with fetch failed`);
		expect(hub.infoUrls).toHaveLength(5);
		expect(sleep).toHaveBeenCalledTimes(4);
	});
});

describe("setupSummary", () => {
	it("lists the hub, the GitHub and Slack installs, agent pairing and upgrades, in that order", () => {
		const lines = setupSummary(registered({ slack_configured: true })).split("\n");
		const order = [
			`Hub: ${BASE}`,
			"Install the GitHub App: https://github.com/apps/acme-hookci/installations/new",
			`Add to Slack: ${BASE}/slack/install`,
			`  curl -fsSL ${BASE}/install | sh`,
			`  hookci connect --hub ${BASE} <pair-token>`,
			"Upgrade later with: npx hookci-hub upgrade",
		].map((line) => lines.indexOf(line));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(lines).not.toContain(NO_SLACK_REMINDER);
	});
});
