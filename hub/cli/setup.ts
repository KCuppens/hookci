import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { packageRoot, packageVersion } from "./package.js";
import { parseD1Create, parseD1List, parseDeployUrl, parseR2List, parseWhoami } from "./parse.js";
import type { Prompter } from "./prompts.js";
import { type SetupContext, githubAppStep } from "./manifest-flow.js";
import { NO_SLACK_REMINDER, setupSummary, slackAppStep, verifyStep } from "./slack-step.js";
import { installBundle, readTemplate, renderWranglerToml } from "./render.js";
import { type HubState, loadState, saveState } from "./state.js";
import type { Exec, ExecResult } from "./wrangler.js";

export interface SetupOptions {
	dir: string;
	yes: boolean;
	exec: Exec;
	prompter: Prompter;
	fetchFn: typeof fetch;
	randomBytes?: (n: number) => Uint8Array;
	/** Skip the Slack App step; a later setup run without it adds Slack. */
	noSlack?: boolean;
	/** GitHub organization login to own the hub's GitHub App; the signed-in user owns it when unset. */
	org?: string;
	/** Shows the user the local manifest page; the default leaves it to the printed URL. */
	openBrowser?: (url: string) => Promise<void>;
	/** github.com and api.github.com stand-ins, for tests. */
	githubBase?: string;
	githubApiBase?: string;
	/** Rerun the render and deploy steps even when the state says they are done. */
	forceRender?: boolean;
	log?: (line: string) => void;
	/** Package root holding the template, dist/worker and migrations; defaults to this package. */
	root?: string;
	/** Waits between /v1/info attempts in the verify step; tests skip the wait. */
	sleep?: (ms: number) => Promise<void>;
}

export const SETUP_STEPS = [
	"preflight",
	"account",
	"d1",
	"r2",
	"r2_lifecycle",
	"render",
	"migrate",
	"deploy",
	"secrets",
	"github_app",
	"slack_app",
	"verify",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export type SetupErrorCode =
	| "node_too_old"
	| "not_logged_in"
	| "multiple_accounts"
	| "wrangler_failed"
	| "parse_failed"
	| "bad_name"
	| "manifest_timeout"
	| "manifest_conversion_failed"
	| "github_app_verify_failed"
	| "not_set_up"
	| "downgrade"
	| "version_mismatch"
	| "bad_manifest"
	| "missing_input"
	| "verify_failed";

const HINTS: Record<SetupErrorCode, string> = {
	node_too_old: "Install Node.js 20 or newer, then run zeroci-hub setup again.",
	not_logged_in: "Or set CLOUDFLARE_API_TOKEN, then run zeroci-hub setup again.",
	multiple_accounts: "Set CLOUDFLARE_ACCOUNT_ID to the account to use, or run without --yes to pick one.",
	wrangler_failed: "Fix the cause shown above, then run zeroci-hub setup again; finished steps are skipped.",
	parse_failed: "Run zeroci-hub setup again; if it fails the same way, report it with the wrangler output.",
	bad_name: "Use 3 to 41 lowercase letters, digits or dashes, starting with a letter.",
	manifest_timeout: "Run zeroci-hub setup again and finish creating the GitHub App in the browser within 10 minutes.",
	manifest_conversion_failed: "The manifest code is single-use and expires after an hour; run zeroci-hub setup again.",
	github_app_verify_failed: "Delete the new app in GitHub settings, then run zeroci-hub setup again.",
	not_set_up: "run zeroci-hub setup first",
	downgrade: "Run a zeroci-hub as new as the hub or newer; D1 migrations only move forward.",
	version_mismatch: "Check npx wrangler deployments list in the state dir, then run zeroci-hub upgrade again.",
	bad_manifest: "Reinstall zeroci-hub; its Slack manifest must ask for exactly the bot scopes the hub uses.",
	missing_input: "Copy the value from the Slack App's Basic Information page, then run zeroci-hub setup again.",
	verify_failed: "Check npx wrangler deployments list in the state dir, then run zeroci-hub setup again; finished steps are skipped.",
};

export class SetupError extends Error {
	constructor(
		public readonly code: SetupErrorCode,
		message: string,
		/** The last lines wrangler printed to stderr, for `wrangler_failed`. */
		public readonly detail = "",
	) {
		super(message);
		this.name = "SetupError";
	}

	get hint(): string {
		return HINTS[this.code];
	}
}

const MIN_NODE_MAJOR = 20;
const NAME = /^[a-z][a-z0-9-]{2,40}$/;
const DEFAULT_NAME = "zeroci-hub";
const LIFECYCLE_RULE = "zeroci-log-retention";
const STDERR_TAIL_LINES = 20;

const STEP_LABELS: Record<SetupStep, string> = {
	preflight: "Checking Node.js and the wrangler login",
	account: "Choosing the Cloudflare account and hub name",
	d1: "Creating the D1 database",
	r2: "Creating the R2 log bucket",
	r2_lifecycle: "Adding the 14-day log retention rule",
	render: "Writing wrangler.toml and the Worker bundle",
	migrate: "Applying D1 migrations",
	deploy: "Deploying the Worker",
	secrets: "Storing generated Worker secrets",
	github_app: "Registering the hub's GitHub App",
	slack_app: "Connecting the hub's Slack App",
	verify: "Checking the deployed hub",
};

/** Worker secrets setup generates; GitHub and Slack credentials come from their manifest flows. */
const GENERATED_SECRETS: { name: string; value: (key: string) => string }[] = [
	{ name: "TOKEN_ENC_KEYS", value: (key) => JSON.stringify({ current: 1, keys: { "1": key } }) },
	{ name: "STATE_SIGNING_KEY", value: (key) => key },
	{ name: "LOG_SIGNING_KEY", value: (key) => key },
];

export function wranglerFailed(args: string[], r: ExecResult): SetupError {
	const stderrTail = stripVTControlCharacters(r.stderr).trimEnd().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
	return new SetupError("wrangler_failed", `wrangler ${args.join(" ")} exited with code ${r.code}`, stderrTail);
}

/** Runs wrangler in the state dir, scoped to the chosen account once there is one. */
async function wrangler(o: SetupOptions, s: HubState | null, args: string[]): Promise<ExecResult> {
	const r = await o.exec(args, { cwd: o.dir, ...(s?.account_id ? { env: { CLOUDFLARE_ACCOUNT_ID: s.account_id } } : {}) });
	if (r.code !== 0) throw wranglerFailed(args, r);
	return r;
}

// preflight and resolveAccount both need `wrangler whoami`; one run asks once.
const whoamiRuns = new WeakMap<SetupOptions, Promise<ExecResult>>();

function whoami(o: SetupOptions): Promise<ExecResult> {
	let run = whoamiRuns.get(o);
	if (!run) {
		run = wrangler(o, null, ["whoami"]);
		whoamiRuns.set(o, run);
	}
	return run;
}

function hubName(s: HubState): string {
	if (!s.name) throw new SetupError("bad_name", "the setup state has no hub name");
	return s.name;
}

function need(value: string | undefined, what: string): string {
	if (!value) throw new Error(`the setup state has no ${what}; run zeroci-hub setup without --force-render`);
	return value;
}

export async function preflight(o: SetupOptions): Promise<void> {
	const major = Number(process.versions.node.split(".")[0]);
	if (major < MIN_NODE_MAJOR) throw new SetupError("node_too_old", `zeroci-hub needs Node.js ${MIN_NODE_MAJOR} or newer, this is ${process.versions.node}`);
	const r = await whoami(o);
	if (/not authenticated/i.test(stripVTControlCharacters(r.stdout)) && !process.env.CLOUDFLARE_API_TOKEN) {
		throw new SetupError("not_logged_in", "run: npx wrangler login");
	}
}

async function chooseAccount(o: SetupOptions, accounts: { id: string; name: string }[]): Promise<string> {
	const list = accounts.map((a, i) => `${i + 1}) ${a.name} (${a.id})`).join(", ");
	for (let attempt = 0; attempt < 3; attempt++) {
		const answer = (await o.prompter.ask(`Cloudflare account: ${list}`, "1")).trim();
		const picked = accounts[Number(answer) - 1] ?? accounts.find((a) => a.id === answer);
		if (picked) return picked.id;
	}
	throw new SetupError("multiple_accounts", "no Cloudflare account chosen");
}

export async function resolveAccount(o: SetupOptions, s: HubState): Promise<HubState> {
	let accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
	if (!accountId) {
		const { accounts } = parseWhoami((await whoami(o)).stdout);
		const [only] = accounts;
		if (only && accounts.length === 1) accountId = only.id;
		else if (o.yes) throw new SetupError("multiple_accounts", `wrangler can use ${accounts.length} Cloudflare accounts`);
		else accountId = await chooseAccount(o, accounts);
	}
	const name = o.yes ? DEFAULT_NAME : (await o.prompter.ask("Hub name", DEFAULT_NAME)).trim();
	if (!NAME.test(name)) throw new SetupError("bad_name", `"${name}" is not a valid hub name`);
	const domain = o.yes ? "" : (await o.prompter.ask("Custom domain (empty for workers.dev)", "")).trim();
	const next: HubState = { ...s, account_id: accountId, name };
	if (domain) next.custom_domain = domain;
	else delete next.custom_domain;
	return next;
}

export async function ensureD1(o: SetupOptions, s: HubState, name: string): Promise<HubState> {
	const db = `${name}-db`;
	const existing = parseD1List((await wrangler(o, s, ["d1", "list", "--json"])).stdout).find((d) => d.name === db);
	const id = existing ? existing.uuid : parseD1Create((await wrangler(o, s, ["d1", "create", db])).stdout);
	return { ...s, d1_database_id: id };
}

export async function ensureR2(o: SetupOptions, s: HubState, name: string): Promise<HubState> {
	const bucket = `${name}-logs`;
	if (!parseR2List((await wrangler(o, s, ["r2", "bucket", "list"])).stdout).includes(bucket)) {
		await wrangler(o, s, ["r2", "bucket", "create", bucket]);
	}
	return { ...s, r2_bucket: bucket };
}

/** Adds the 14-day expiry rule for `logs/`; a rule left by an earlier run counts as done. */
export async function applyLifecycle(o: SetupOptions, s: HubState): Promise<HubState> {
	const args = ["r2", "bucket", "lifecycle", "add", need(s.r2_bucket, "R2 bucket"), LIFECYCLE_RULE, "--expire-days", "14", "--prefix", "logs/"];
	const r = await o.exec(args, { cwd: o.dir, env: { CLOUDFLARE_ACCOUNT_ID: s.account_id } });
	if (r.code !== 0 && !/already exists/i.test(r.stderr)) throw wranglerFailed(args, r);
	return s;
}

/** The base URL wrangler.toml is rendered with: the known hub URL, the custom domain, or empty before the first deploy. */
function renderedBaseUrl(s: HubState): string {
	return s.base_url ?? (s.custom_domain ? `https://${s.custom_domain}` : "");
}

/** The wrangler.toml for `s`, rendered from the template under `root` with this package's version. */
export async function wranglerTomlFor(s: HubState, root = packageRoot(), baseUrl = renderedBaseUrl(s)): Promise<string> {
	return renderWranglerToml(await readTemplate(root), {
		name: hubName(s),
		accountId: s.account_id,
		d1DatabaseId: need(s.d1_database_id, "D1 database id"),
		r2Bucket: need(s.r2_bucket, "R2 bucket"),
		baseUrl,
		hubVersion: packageVersion(),
		...(s.github_app_slug ? { githubAppSlug: s.github_app_slug } : {}),
		...(s.custom_domain ? { customDomain: s.custom_domain } : {}),
	});
}

async function writeWranglerToml(o: SetupOptions, s: HubState, baseUrl: string): Promise<void> {
	await writeFile(join(o.dir, "wrangler.toml"), await wranglerTomlFor(s, o.root, baseUrl));
}

export async function renderConfig(o: SetupOptions, s: HubState): Promise<HubState> {
	await installBundle(o.dir, o.root ?? packageRoot());
	await writeWranglerToml(o, s, renderedBaseUrl(s));
	return s;
}

export async function applyMigrations(o: SetupOptions, s: HubState): Promise<HubState> {
	await wrangler(o, s, ["d1", "migrations", "apply", `${hubName(s)}-db`, "--remote"]);
	return s;
}

/**
 * Deploys the Worker and records its URL. When that URL differs from the one
 * wrangler.toml was rendered with (the first deploy to workers.dev), renders
 * again and deploys a second time so HUB_ORIGIN is right.
 */
export async function deployWorker(o: SetupOptions, s: HubState): Promise<HubState> {
	const rendered = renderedBaseUrl(s);
	const r = await wrangler(o, s, ["deploy"]);
	const url = s.custom_domain ? `https://${s.custom_domain}` : parseDeployUrl(r.stdout);
	if (!url) throw new SetupError("parse_failed", "wrangler deploy printed no workers.dev URL");
	const next: HubState = { ...s, base_url: url, version: packageVersion() };
	if (url !== rendered) {
		await writeWranglerToml(o, next, url);
		await wrangler(o, next, ["deploy"]);
	}
	return next;
}

/** Stores one Worker secret; the value travels on stdin only. */
export async function putSecret(exec: Exec, dir: string, name: string, value: string): Promise<void> {
	const args = ["secret", "put", name];
	const r = await exec(args, { cwd: dir, stdin: value });
	if (r.code !== 0) throw wranglerFailed(args, r);
}

/** Generates and stores each Worker secret not stored yet, saving the state after each one. */
export async function putSecrets(o: SetupOptions, s: HubState): Promise<HubState> {
	const random = o.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
	let next = s;
	for (const secret of GENERATED_SECRETS) {
		if (next.secrets_set?.includes(secret.name)) continue;
		const key = Buffer.from(random(32)).toString("base64");
		await putSecret(o.exec, o.dir, secret.name, secret.value(key));
		next = { ...next, secrets_set: [...(next.secrets_set ?? []), secret.name] };
		await saveState(o.dir, next);
	}
	return next;
}

function setupContext(o: SetupOptions, s: HubState): SetupContext {
	return { options: o, state: s, exec: o.exec, log: o.log ?? (() => {}) };
}

const STEPS: Record<SetupStep, (o: SetupOptions, s: HubState) => Promise<HubState>> = {
	preflight: async (o, s) => {
		await preflight(o);
		return s;
	},
	account: resolveAccount,
	d1: (o, s) => ensureD1(o, s, hubName(s)),
	r2: (o, s) => ensureR2(o, s, hubName(s)),
	r2_lifecycle: applyLifecycle,
	render: renderConfig,
	migrate: applyMigrations,
	deploy: deployWorker,
	secrets: putSecrets,
	github_app: (o, s) => githubAppStep(setupContext(o, s)),
	slack_app: (o, s) => slackAppStep(setupContext(o, s)),
	verify: (o, s) => verifyStep(setupContext(o, s)),
};

/**
 * Creates or resumes a self-hosted hub in `o.dir`. Each finished step is
 * saved to the state file at once, so a rerun picks up after the last one.
 * `--no-slack` leaves the Slack step undone for a later run. Ends with what
 * to do next, also when every step was done earlier.
 */
export async function runSetup(o: SetupOptions): Promise<HubState> {
	await mkdir(o.dir, { recursive: true, mode: 0o700 });
	let s: HubState = (await loadState(o.dir)) ?? { account_id: "", version: packageVersion(), steps_done: [] };
	for (const [i, step] of SETUP_STEPS.entries()) {
		const label = `[${i + 1}/${SETUP_STEPS.length}] ${STEP_LABELS[step]}`;
		const forced = o.forceRender === true && (step === "render" || step === "deploy");
		if (s.steps_done.includes(step) && !forced) {
			o.log?.(`${label}: done earlier`);
			continue;
		}
		o.log?.(label);
		if (step === "slack_app" && o.noSlack) {
			o.log?.(NO_SLACK_REMINDER);
			continue;
		}
		s = await STEPS[step](o, s);
		if (!s.steps_done.includes(step)) s = { ...s, steps_done: [...s.steps_done, step] };
		await saveState(o.dir, s);
	}
	o.log?.(setupSummary(s));
	return s;
}
