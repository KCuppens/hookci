import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot, packageVersion } from "./package.js";
import { parseMigrationsList } from "./parse.js";
import type { Prompter } from "./prompts.js";
import { applyMigrations, deployWorker, renderConfig, SetupError, type SetupOptions, wranglerFailed, wranglerTomlFor } from "./setup.js";
import { type HubState, loadState, saveState } from "./state.js";
import type { Exec } from "./wrangler.js";

export interface UpgradeOptions {
	dir: string;
	exec: Exec;
	fetchFn: typeof fetch;
	log?: (s: string) => void;
	dryRun?: boolean;
	yes?: boolean;
	prompter: Prompter;
	/** Package root holding the template, dist/worker and migrations; defaults to this package. */
	root?: string;
}

export interface UpgradePlan {
	fromVersion: string;
	toVersion: string;
	pendingMigrations: string[];
	configChanged: boolean;
}

type DeployedState = HubState & { name: string; base_url: string };

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC = /^\d+$/;

function parseSemver(v: string): { core: [number, number, number]; pre: string[] } {
	const m = SEMVER.exec(v);
	if (!m) throw new Error(`"${v}" is not a semantic version`);
	return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence of pre-release identifiers: none sorts above any; numeric ones sort below alphanumeric ones. */
function comparePre(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return b.length - a.length;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const x = a[i] as string;
		const y = b[i] as string;
		if (x === y) continue;
		const xNum = NUMERIC.test(x);
		const yNum = NUMERIC.test(y);
		if (xNum && yNum) return Number(x) - Number(y);
		if (xNum !== yNum) return xNum ? -1 : 1;
		return x < y ? -1 : 1;
	}
	return a.length - b.length;
}

/** Orders two semantic versions by major.minor.patch, a pre-release below its release; returns -1, 0 or 1. */
export function compareSemver(a: string, b: string): number {
	const x = parseSemver(a);
	const y = parseSemver(b);
	for (let i = 0; i < 3; i++) {
		const d = (x.core[i] as number) - (y.core[i] as number);
		if (d !== 0) return Math.sign(d);
	}
	return Math.sign(comparePre(x.pre, y.pre));
}

async function deployedState(dir: string): Promise<DeployedState> {
	const s = await loadState(dir);
	if (!s) throw new SetupError("not_set_up", `no hookci-hub setup state in ${dir}`);
	if (!s.name || !s.base_url) throw new SetupError("not_set_up", `hookci-hub setup in ${dir} has not deployed the hub yet`);
	return { ...s, name: s.name, base_url: s.base_url };
}

/**
 * The migrations of this package the hub's D1 has not applied. wrangler reads
 * them from the migrations dir next to wrangler.toml, and the state dir holds
 * the installed version's until the upgrade runs, so wrangler runs in a
 * scratch dir with the new wrangler.toml and migrations.
 */
async function pendingMigrations(o: UpgradeOptions, s: DeployedState, root: string, toml: string): Promise<string[]> {
	const scratch = await mkdtemp(join(tmpdir(), "hookci-hub-upgrade-"));
	try {
		await writeFile(join(scratch, "wrangler.toml"), toml);
		await cp(join(root, "migrations"), join(scratch, "migrations"), { recursive: true });
		const args = ["d1", "migrations", "list", `${s.name}-db`, "--remote"];
		const r = await o.exec(args, { cwd: scratch, env: { CLOUDFLARE_ACCOUNT_ID: s.account_id } });
		if (r.code !== 0) throw wranglerFailed(args, r);
		return parseMigrationsList(r.stdout);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function plan(o: UpgradeOptions, s: DeployedState): Promise<UpgradePlan> {
	const root = o.root ?? packageRoot();
	const toml = await wranglerTomlFor(s, root);
	const onDisk = await readFile(join(o.dir, "wrangler.toml"), "utf8").catch(() => null);
	return {
		fromVersion: s.version,
		toVersion: packageVersion(),
		pendingMigrations: await pendingMigrations(o, s, root, toml),
		configChanged: toml !== onDisk,
	};
}

/** What upgrading the hub set up in `o.dir` to this package's version would change; writes nothing to the state dir. */
export async function planUpgrade(o: UpgradeOptions): Promise<UpgradePlan> {
	return plan(o, await deployedState(o.dir));
}

/** Fails unless the hub at `baseUrl` reports version `want` on /v1/info. */
async function checkDeployedVersion(fetchFn: typeof fetch, baseUrl: string, want: string): Promise<void> {
	const url = `${baseUrl}/v1/info`;
	let got: unknown;
	try {
		const res = await fetchFn(url, { headers: { accept: "application/json" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body: unknown = await res.json();
		got = body && typeof body === "object" && "version" in body ? body.version : undefined;
	} catch (err) {
		throw new SetupError("version_mismatch", `GET ${url} failed after the deploy: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (got !== want) throw new SetupError("version_mismatch", `the hub at ${baseUrl} reports version ${String(got)} after the deploy, not ${want}`);
}

/**
 * Upgrades the hub set up in `o.dir` to this package's version: re-renders
 * wrangler.toml and the bundle, applies pending D1 migrations, deploys, checks
 * the deployed version and records it. A dry run or a declined confirmation
 * stops after printing the plan.
 */
export async function runUpgrade(o: UpgradeOptions): Promise<UpgradePlan> {
	const log = o.log ?? (() => {});
	const s = await deployedState(o.dir);
	const toVersion = packageVersion();
	if (compareSemver(toVersion, s.version) < 0) {
		throw new SetupError("downgrade", `the hub runs ${s.version}, newer than this hookci-hub ${toVersion}`);
	}
	const p = await plan(o, s);
	log(`Upgrading ${s.name} at ${s.base_url} from ${p.fromVersion} to ${p.toVersion}`);
	log(`D1 migrations to apply: ${p.pendingMigrations.length > 0 ? p.pendingMigrations.join(", ") : "none"}`);
	log(`wrangler.toml: ${p.configChanged ? "changes" : "unchanged"}`);
	if (o.dryRun) {
		log("Dry run: nothing changed.");
		return p;
	}
	if (!o.yes && !(await o.prompter.confirm(`Upgrade ${s.name} to ${toVersion}?`, false))) {
		log("Upgrade cancelled: nothing changed.");
		return p;
	}

	const so: SetupOptions = {
		dir: o.dir,
		yes: o.yes ?? false,
		exec: o.exec,
		prompter: o.prompter,
		fetchFn: o.fetchFn,
		log,
		...(o.root ? { root: o.root } : {}),
	};
	let next: HubState = await renderConfig(so, s);
	next = await applyMigrations(so, next);
	next = await deployWorker(so, next);
	await checkDeployedVersion(o.fetchFn, next.base_url ?? s.base_url, toVersion);
	await saveState(o.dir, { ...next, version: toVersion });
	log(`Upgraded ${s.name} to ${toVersion}`);
	return p;
}
