// Which fork pull requests may run, read from `.hookci.yml` on the base ref.
// The fork's head never decides its own policy.

import type { GitHubRequester } from "../github/client";
import type { HubTrigger } from "../github/normalize";
import { logEvent } from "../observability";

export type ForkPolicy = "approve" | "never";
export interface ForkPolicyResult {
	policy: ForkPolicy;
	/** `trust: all` was set; the shared hub ignores it and gates the fork anyway. */
	trustAllRefused: boolean;
}

export function isForkPr(pr: HubTrigger["pr"]): boolean {
	return pr?.fork === true;
}

// A top-level `key: value` line with a plain or quoted scalar and an optional comment.
const TOP_LEVEL_SCALAR = /^(forks|trust):[ \t]*(["']?)([\w-]+)\2[ \t]*(#.*)?$/;

/**
 * The fork policy of repo (owner/name) at baseRef; a missing file means approve.
 * Only the top-level scalars `forks` and `trust` matter here, so the file is
 * scanned for those lines instead of parsed as a whole.
 */
export async function loadForkPolicy(gh: GitHubRequester, repo: string, baseRef: string): Promise<ForkPolicyResult> {
	const text = await gh.getRepoFileAtRef(repo, ".hookci.yml", baseRef);
	const keys: Record<string, string> = {};
	for (const line of text?.split(/\r?\n/) ?? []) {
		const m = TOP_LEVEL_SCALAR.exec(line);
		if (m) keys[m[1]!] = m[3]!;
	}
	const trustAllRefused = keys.trust === "all";
	if (trustAllRefused) logEvent("trust_all_refused", { repo });
	return { policy: keys.forks === "never" ? "never" : "approve", trustAllRefused };
}
