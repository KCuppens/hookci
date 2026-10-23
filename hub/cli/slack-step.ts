import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { SetupContext } from "./manifest-flow.js";
import { packageRoot } from "./package.js";
import { SetupError, putSecret } from "./setup.js";
import type { HubState } from "./state.js";

/** The bot scopes the hub's Slack features need, in the hosted manifest's order. */
export const SLACK_BOT_SCOPES = ["chat:write", "commands", "channels:read", "groups:read", "im:write", "users:read", "users:read.email"] as const;

export const NO_SLACK_REMINDER = "Skipping Slack (--no-slack). Run hookci-hub setup again later to add it.";

const INPUT_ATTEMPTS = 3;
const CLIENT_ID = /^\d+\.\d+$/;
const VERIFY_ATTEMPTS = 5;
const VERIFY_BACKOFF_MS = 2000;

interface SlackManifest {
	display_information: { name: string } & Record<string, unknown>;
	features: {
		bot_user: { display_name: string } & Record<string, unknown>;
		slash_commands: ({ url: string } & Record<string, unknown>)[];
	} & Record<string, unknown>;
	oauth_config: { redirect_urls: string[]; scopes: { bot: string[] } } & Record<string, unknown>;
	settings: {
		event_subscriptions: { request_url: string } & Record<string, unknown>;
		interactivity: { request_url: string } & Record<string, unknown>;
	} & Record<string, unknown>;
}

/**
 * The self-hosted Slack App manifest: the hosted app's features and scopes,
 * named `name`, with every URL on `baseUrl`. `root` holds manifests/slack-app.yml.
 */
export function renderSlackManifest(baseUrl: string, name: string, root = packageRoot()): SlackManifest {
	const shared = parse(readFileSync(join(root, "manifests", "slack-app.yml"), "utf8")) as SlackManifest;
	const scopes = shared.oauth_config.scopes.bot;
	if (scopes.length !== SLACK_BOT_SCOPES.length || scopes.some((scope, i) => scope !== SLACK_BOT_SCOPES[i])) {
		throw new SetupError("bad_manifest", `the Slack manifest asks for bot scopes ${scopes.join(", ")}, not ${SLACK_BOT_SCOPES.join(", ")}`);
	}
	const base = baseUrl.replace(/\/+$/, "");
	// The hosted manifest's paths, moved onto this hub, so the two cannot drift.
	const rebase = (url: string): string => {
		const u = new URL(url);
		return `${base}${u.pathname}${u.search}`;
	};
	const { features, oauth_config, settings } = shared;
	return {
		...shared,
		display_information: { ...shared.display_information, name },
		features: {
			...features,
			bot_user: { ...features.bot_user, display_name: name },
			slash_commands: features.slash_commands.map((command) => ({ ...command, url: rebase(command.url) })),
		},
		oauth_config: { ...oauth_config, redirect_urls: oauth_config.redirect_urls.map(rebase) },
		settings: {
			...settings,
			event_subscriptions: { ...settings.event_subscriptions, request_url: rebase(settings.event_subscriptions.request_url) },
			interactivity: { ...settings.interactivity, request_url: rebase(settings.interactivity.request_url) },
		},
	};
}

/** Slack's "create an app from this manifest" link. */
export function slackNewAppUrl(manifest: object): string {
	return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

function needBaseUrl(s: HubState): string {
	if (!s.base_url) throw new Error("the setup state has no hub URL; the deploy step must run first");
	return s.base_url.replace(/\/+$/, "");
}

/**
 * Asks for one value until it is non-empty and, with `format`, well formed;
 * gives up with `missing_input` after three tries.
 */
async function promptValue(
	log: (line: string) => void,
	label: string,
	read: () => Promise<string>,
	format?: { pattern: RegExp; example: string },
): Promise<string> {
	for (let attempt = 1; attempt <= INPUT_ATTEMPTS; attempt++) {
		const value = (await read()).trim();
		if (value === "") {
			log(`The ${label} is empty; copy it from Basic Information.`);
		} else if (format && !format.pattern.test(value)) {
			log(`The ${label} "${value}" does not look like ${format.example}.`);
		} else {
			return value;
		}
	}
	throw new SetupError("missing_input", `no ${label} after ${INPUT_ATTEMPTS} tries`);
}

/**
 * Has the user create the hub's Slack App from its manifest, then stores the
 * app's signing secret and OAuth client as Worker secrets.
 */
export async function slackAppStep(ctx: SetupContext): Promise<HubState> {
	const { options: o, state: s, exec, log } = ctx;
	const base = needBaseUrl(s);
	log(`Create the Slack App: ${slackNewAppUrl(renderSlackManifest(base, s.name ?? "hookci"))}`);
	log("Create the app from the manifest, choose the workspace, then open Basic Information and copy its App Credentials here.");
	const secrets: [string, string][] = [
		["SLACK_SIGNING_SECRET", await promptValue(log, "Slack Signing Secret", () => o.prompter.secret("Slack Signing Secret"))],
		[
			"SLACK_CLIENT_ID",
			await promptValue(log, "Slack Client ID", () => o.prompter.ask("Slack Client ID"), { pattern: CLIENT_ID, example: "1234567890.1234567890" }),
		],
		["SLACK_CLIENT_SECRET", await promptValue(log, "Slack Client Secret", () => o.prompter.secret("Slack Client Secret"))],
	];
	for (const [name, value] of secrets) await putSecret(exec, o.dir, name, value);
	log(`Add to Slack: ${base}/slack/install`);
	return { ...s, slack_configured: true };
}

interface HubInfo {
	version?: unknown;
	mode?: unknown;
	github_app?: { slug?: unknown };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchInfo(fetchFn: typeof fetch, url: string): Promise<{ info: HubInfo } | { error: string }> {
	try {
		const res = await fetchFn(url, { headers: { accept: "application/json" } });
		if (!res.ok) return { error: `HTTP ${res.status}` };
		return { info: (await res.json()) as HubInfo };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Reads the deployed hub's /v1/info, retrying while the deploy propagates,
 * and checks it is this self-hosted hub with this GitHub App.
 */
export async function verifyStep(ctx: SetupContext): Promise<HubState> {
	const { options: o, state: s, log } = ctx;
	const url = `${needBaseUrl(s)}/v1/info`;
	const sleep = o.sleep ?? defaultSleep;
	let last: { info: HubInfo } | { error: string } = { error: "not fetched" };
	for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
		if (attempt > 1) await sleep(VERIFY_BACKOFF_MS);
		last = await fetchInfo(o.fetchFn, url);
		if ("info" in last) break;
	}
	if ("error" in last) throw new SetupError("verify_failed", `GET ${url} failed ${VERIFY_ATTEMPTS} times, last with ${last.error}`);
	const { mode, version, github_app } = last.info;
	if (mode !== "self_hosted") throw new SetupError("verify_failed", `${url} reports mode ${JSON.stringify(mode)}, not "self_hosted"`);
	const slug = github_app?.slug;
	if (slug !== s.github_app_slug) {
		throw new SetupError("verify_failed", `${url} reports GitHub App ${JSON.stringify(slug)}, not ${JSON.stringify(s.github_app_slug)}`);
	}
	if (typeof version !== "string" || version === "") throw new SetupError("verify_failed", `${url} reports no version`);
	log(`The hub at ${needBaseUrl(s)} answers as version ${version}`);
	return { ...s, hub_version_seen: version };
}

/** What to do next once setup has finished. */
export function setupSummary(s: HubState): string {
	const base = needBaseUrl(s);
	if (!s.github_app_slug) throw new Error("the setup state has no GitHub App; the github_app step must run first");
	return [
		`Hub: ${base}`,
		`Install the GitHub App: https://github.com/apps/${s.github_app_slug}/installations/new`,
		s.slack_configured ? `Add to Slack: ${base}/slack/install` : NO_SLACK_REMINDER,
		"Pair an agent with the pair token shown after the GitHub App install or in Slack App Home:",
		`  curl -fsSL ${base}/install | sh`,
		`  hookci connect --hub ${base} <pair-token>`,
		"Upgrade later with: npx hookci-hub upgrade",
	].join("\n");
}
