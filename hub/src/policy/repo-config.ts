// Which events start runs, read from the repo's `.hookci.yml` the way GitHub
// Actions reads a workflow's `on:`: `checks.on.pull_request`,
// `checks.on.push.branches` and each `deployments.<env>.on.push`. The agent
// validates the file in full; the hub only needs these keys, so anything it
// cannot read keeps the defaults and the agent reports the error on the run.

import { parse } from "yaml";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { GitHubClient } from "../github/client";
import type { HubTrigger } from "../github/normalize";
import { defaultFetcher } from "../http";

export interface RepoTriggers {
	pullRequest: boolean;
	/** Branch patterns from checks.on.push.branches; null when unset (the default branch). */
	pushBranches: string[] | null;
	/** deployments.<env>.on.push of each env that names one. */
	deployBranches: Record<string, string>;
}

const DEFAULTS: RepoTriggers = { pullRequest: true, pushBranches: null, deployBranches: {} };

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
}

/** The triggers of a `.hookci.yml` text; null (no file) and unreadable YAML give the defaults. */
export function readRepoTriggers(text: string | null): RepoTriggers {
	if (text === null) return DEFAULTS;
	let doc: unknown;
	try {
		doc = parse(text);
	} catch {
		return DEFAULTS;
	}
	const on = obj(obj(obj(doc)?.checks)?.on);
	const branches = obj(on?.push)?.branches;
	const deployBranches: Record<string, string> = {};
	for (const [name, dep] of Object.entries(obj(obj(doc)?.deployments) ?? {})) {
		const push = obj(obj(dep)?.on)?.push;
		if (typeof push === "string" && push !== "") deployBranches[name] = push;
	}
	return {
		pullRequest: typeof on?.pull_request === "boolean" ? on.pull_request : DEFAULTS.pullRequest,
		pushBranches: Array.isArray(branches) && branches.every((b) => typeof b === "string") ? branches : null,
		deployBranches,
	};
}

/** The triggers of repo (owner/name) at ref; a missing file gives the defaults. */
export async function fetchRepoTriggers(env: Env, installationId: number, repo: string, ref: string): Promise<RepoTriggers> {
	const clock = env.__TEST_CLOCK ?? systemClock;
	const gh = await new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => clock.now()).installation(installationId);
	return readRepoTriggers(await gh.getRepoFileAtRef(repo, ".hookci.yml", ref));
}

/**
 * Whether branch matches an Actions-style pattern: `**` matches any run of
 * characters, `*` any run without `/`; everything else is literal.
 */
export function branchMatches(pattern: string, branch: string): boolean {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === "*" && pattern[i + 1] === "*") {
			re += ".*";
			i++;
		} else if (c === "*") {
			re += "[^/]*";
		} else {
			re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`).test(branch);
}

/** Whether cfg runs checks for trig: PRs per on.pull_request, pushes per on.push.branches or a deployment's branch. */
export function triggerWanted(cfg: RepoTriggers, trig: Pick<HubTrigger, "event" | "ref" | "defaultBranch">): boolean {
	if (trig.event === "pull_request") return cfg.pullRequest;
	const branch = trig.ref.replace(/^refs\/heads\//, "");
	if (Object.values(cfg.deployBranches).includes(branch)) return true;
	return (cfg.pushBranches ?? [trig.defaultBranch]).some((p) => branchMatches(p, branch));
}

/** The ref a trigger's own config is read at: the commit itself, but a fork PR's base so the fork cannot opt out. */
export function triggerConfigRef(trig: Pick<HubTrigger, "sha" | "pr" | "baseSha" | "defaultBranch">): string {
	if (trig.pr?.fork === true) return trig.baseSha ?? trig.defaultBranch;
	return trig.sha;
}
