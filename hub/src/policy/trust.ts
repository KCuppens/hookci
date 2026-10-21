// Who may run without approval. `trust: all` lets fork pull requests run
// unattended; only a self-hosted hub whose repo has no deploy bindings honors
// it. Policy is read from `.hookci.yml` on the base ref, never the PR head.

import type { Checks } from "../config/generated";
import type { TenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { GitHubClient } from "../github/client";
import { defaultFetcher } from "../http";
import { S } from "../strings";

export type HubMode = "shared" | "self_hosted";
export type Trust = NonNullable<Checks["trust"]>;
export type Forks = NonNullable<Checks["forks"]>;
export type TrustRefusal = "shared_hub" | "deploy_bindings";

export interface TrustDecision {
	declared: Trust;
	effective: Trust;
	refused: TrustRefusal | null;
}

export interface BaseConfig {
	trust: Trust;
	forks: Forks;
}

export const TRUST_REFUSAL_TEXT: Record<TrustRefusal, string> = S.checks.trustRefused;

const DEFAULT_CONFIG: BaseConfig = { trust: "collaborators", forks: "gated" };

/** The hub's mode; anything but an exact "self_hosted" is the shared hub, so a typo fails closed. */
export function hubMode(env: Env): HubMode {
	return env.HUB_MODE === "self_hosted" ? "self_hosted" : "shared";
}

/** The trust repoId actually gets: `all` is refused on the shared hub and wherever the repo deploys. */
export async function effectiveTrust(env: Env, t: TenantDb, repoId: number, declared: Trust): Promise<TrustDecision> {
	if (declared !== "all") return { declared, effective: declared, refused: null };
	if (hubMode(env) === "shared") return { declared, effective: "collaborators", refused: "shared_hub" };
	const deployBinding = await t.first(
		"SELECT 1 FROM repo_bindings WHERE installation_id = ?1 AND repo_id = ?2 AND target LIKE 'deploy:%' LIMIT 1",
		repoId,
	);
	if (deployBinding !== null) return { declared, effective: "collaborators", refused: "deploy_bindings" };
	return { declared, effective: "all", refused: null };
}

// A `key: value` line under `checks:` with a plain or quoted scalar and an optional comment.
const CHECKS_SCALAR = /^(trust|forks):[ \t]*(["']?)([\w-]+)\2[ \t]*(#.*)?$/;

/**
 * The `checks.trust` and `checks.forks` of a `.hookci.yml` text. Only these
 * two scalars matter, so the lines are scanned instead of parsed as YAML
 * (a parser slows isolate start). Anything the scan cannot read, including a
 * flow-style `checks`, a repeated key or an unknown value, keeps the default.
 */
export function readBaseConfig(text: string | null): BaseConfig {
	const found: Partial<Record<"trust" | "forks", string | null>> = {};
	let inChecks = false;
	let indent: string | undefined;
	for (const line of text?.split(/\r?\n/) ?? []) {
		if (/^[ \t]*(#.*)?$/.test(line)) continue;
		const lead = /^ */.exec(line)![0];
		if (lead === "") {
			inChecks = /^checks:[ \t]*(#.*)?$/.test(line);
			indent = undefined;
			continue;
		}
		if (!inChecks) continue;
		indent ??= lead;
		if (lead !== indent) continue;
		const m = CHECKS_SCALAR.exec(line.slice(lead.length));
		if (!m) continue;
		const key = m[1] as "trust" | "forks";
		found[key] = key in found ? null : m[3]!;
	}
	return {
		trust: found.trust === "collaborators" || found.trust === "all" ? found.trust : DEFAULT_CONFIG.trust,
		forks: found.forks === "gated" || found.forks === "never" ? found.forks : DEFAULT_CONFIG.forks,
	};
}

/**
 * The `checks.trust` and `checks.forks` of repo (owner/name) at baseRef; a
 * missing or unreadable file, or an unknown value, falls back to the default.
 */
export async function fetchBaseConfig(env: Env, installationId: number, repo: string, baseRef: string): Promise<BaseConfig> {
	const clock = env.__TEST_CLOCK ?? systemClock;
	const gh = await new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => clock.now()).installation(installationId);
	return readBaseConfig(await gh.getRepoFileAtRef(repo, ".hookci.yml", baseRef));
}
