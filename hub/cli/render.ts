import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { packageRoot, packageVersion } from "./package.js";
import type { Prompter } from "./prompts.js";
import { loadState } from "./state.js";

export interface RenderInput {
	name: string;
	accountId: string;
	d1DatabaseId: string;
	r2Bucket: string;
	/** Empty only for the first setup deploy, before wrangler has printed the workers.dev URL. */
	baseUrl: string;
	/** The package version, served by the Worker as HUB_VERSION (/healthz, /v1/info). */
	hubVersion: string;
	customDomain?: string;
	githubApiUrl?: string;
	/** The GitHub App's URL slug; `zeroci` until setup has registered the hub's own app. */
	githubAppSlug?: string;
	/** security.txt contact; empty makes the hub fall back to GitHub security advisories. */
	securityContact?: string;
}

export const TEMPLATE_FILE = join("templates", "wrangler.self-hosted.toml.tmpl");
export const DEFAULT_GITHUB_API_URL = "https://api.github.com";
export const DEFAULT_GITHUB_APP_SLUG = "zeroci";

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;
/** Placeholders that may render as empty. */
const OPTIONAL_PLACEHOLDERS: Record<string, true> = { securityContact: true, routes: true, baseUrl: true };

/** Escapes a value for use inside a TOML basic string; JSON string escapes are a subset TOML accepts. */
function tomlEscape(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

/**
 * Fills `{{placeholder}}` slots in the self-hosted wrangler template. Values
 * are TOML-escaped, except `{{routes}}`, which becomes a custom_domain route
 * or nothing. Throws listing every placeholder left without a value.
 */
export function renderWranglerToml(tmpl: string, i: RenderInput): string {
	const values: Record<string, string> = {
		name: tomlEscape(i.name),
		accountId: tomlEscape(i.accountId),
		d1DatabaseId: tomlEscape(i.d1DatabaseId),
		r2Bucket: tomlEscape(i.r2Bucket),
		baseUrl: tomlEscape(i.baseUrl),
		hubVersion: tomlEscape(i.hubVersion),
		githubApiUrl: tomlEscape(i.githubApiUrl || DEFAULT_GITHUB_API_URL),
		githubAppSlug: tomlEscape(i.githubAppSlug || DEFAULT_GITHUB_APP_SLUG),
		securityContact: tomlEscape(i.securityContact ?? ""),
		routes: i.customDomain ? `routes = [{ pattern = ${JSON.stringify(i.customDomain)}, custom_domain = true }]` : "",
	};
	const missing = new Set<string>();
	const out = tmpl.replace(PLACEHOLDER, (slot, key: string) => {
		const value = values[key];
		if (value === undefined || (value === "" && !OPTIONAL_PLACEHOLDERS[key])) {
			missing.add(slot);
			return slot;
		}
		return value;
	});
	if (missing.size > 0) throw new Error(`wrangler template has no value for ${[...missing].join(", ")}`);
	return out;
}

export async function readTemplate(root = packageRoot()): Promise<string> {
	return readFile(join(root, TEMPLATE_FILE), "utf8");
}

/**
 * Copies the prebuilt Worker (`dist/worker`) and the D1 migrations from the
 * package into the state dir, replacing what an earlier version left there.
 */
export async function installBundle(dir: string, root = packageRoot()): Promise<void> {
	const worker = join(root, "dist", "worker");
	if (!existsSync(join(worker, "index.js"))) throw new Error(`${worker} has no prebuilt Worker; run npm run prepack in the package first`);
	for (const [from, to] of [
		[worker, join(dir, "worker")],
		[join(root, "migrations"), join(dir, "migrations")],
	] as const) {
		await rm(to, { recursive: true, force: true });
		await cp(from, to, { recursive: true });
	}
}

/** Stand-in values for a state dir that has none yet; good for `wrangler deploy --dry-run` only. */
export const PLACEHOLDER_INPUT = {
	name: "zeroci-hub",
	accountId: "00000000000000000000000000000000",
	d1DatabaseId: "00000000-0000-0000-0000-000000000000",
	r2Bucket: "zeroci-hub-logs",
	baseUrl: "https://zeroci-hub.workers.dev",
} as const;

/**
 * The `render` command: writes `<dir>/wrangler.toml` from the saved state
 * (placeholder ids where the state has none) and installs the Worker bundle
 * and migrations next to it. Returns false when the user declines to
 * overwrite a wrangler.toml that differs.
 */
export async function renderStateDir(dir: string, prompter: Prompter, root = packageRoot()): Promise<boolean> {
	const state = await loadState(dir);
	const toml = renderWranglerToml(await readTemplate(root), {
		name: state?.name ?? PLACEHOLDER_INPUT.name,
		accountId: state?.account_id || PLACEHOLDER_INPUT.accountId,
		d1DatabaseId: state?.d1_database_id ?? PLACEHOLDER_INPUT.d1DatabaseId,
		r2Bucket: state?.r2_bucket ?? PLACEHOLDER_INPUT.r2Bucket,
		baseUrl: state?.base_url ?? PLACEHOLDER_INPUT.baseUrl,
		hubVersion: packageVersion(),
		customDomain: state?.custom_domain,
		githubAppSlug: state?.github_app_slug,
	});
	const path = join(dir, "wrangler.toml");
	if (existsSync(path) && (await readFile(path, "utf8")) !== toml && !(await prompter.confirm(`Overwrite ${path}?`, false))) return false;
	await installBundle(dir, root);
	await writeFile(path, toml);
	return true;
}
