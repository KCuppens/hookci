// Shared steps of the repo commands: find `owner/repo` among the
// installations linked to the workspace, then check the caller's GitHub role
// on it.

import type { InstallationRow } from "../db/installations";
import { findRepoForTeam } from "../db/repos";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { getCollaboratorPermission, isOrgAdmin } from "../github/api";
import { GitHubClient } from "../github/client";
import { cachedPermission } from "../github/permission-cache";
import type { RepoPermission } from "../github/types";
import { defaultFetcher } from "../http";
import type { LinkedUser } from "../identity/link";
import { logEvent } from "../observability";

export type PermissionLevel = "read" | "write" | "admin";

export interface ResolvedRepo {
	installationId: number;
	repoId: number;
	fullName: string;
	defaultBranch: string;
}

// maintain counts as write and triage as read.
const LEVEL: Record<RepoPermission, number> = { none: 0, read: 1, triage: 1, write: 2, maintain: 2, admin: 3 };

/** The GitHub client the commands use, on the injected fetcher and clock. */
export function commandGitHub(env: Env): GitHubClient {
	const clock = env.__TEST_CLOCK ?? systemClock;
	return new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => clock.now());
}

/** The repo named fullName (`owner/repo`, any case) in an installation linked to the team; throws repo_not_found (404). */
export async function resolveRepo(env: Env, teamId: string, fullName: string): Promise<ResolvedRepo> {
	const repo = /^[\w.-]+\/[\w.-]+$/.test(fullName) ? await findRepoForTeam(env.DB, teamId, fullName) : null;
	if (!repo) {
		logEvent("tenant_denied", { team_id: teamId, repo: fullName, reason: "repo_not_found" });
		throw new HubError("repo_not_found", 404, `no repo ${fullName} in installations linked to ${teamId}`);
	}
	return { installationId: repo.installation_id, repoId: repo.repo_id, fullName: repo.full_name, defaultBranch: repo.default_branch };
}

/** githubLogin's role on the repo, cached up to 5 minutes. */
async function repoPermission(env: Env, gh: GitHubClient, installationId: number, repoFullName: string, githubLogin: string): Promise<RepoPermission> {
	const [owner = "", repo = ""] = repoFullName.split("/");
	return cachedPermission(installationId, repoFullName, githubLogin, (env.__TEST_CLOCK ?? systemClock).now(), async () =>
		getCollaboratorPermission(await gh.installation(installationId), owner, repo, githubLogin),
	);
}

/** Whether githubLogin's role on the repo, cached up to 5 minutes, is at least need. */
export async function hasPermission(
	env: Env,
	gh: GitHubClient,
	installationId: number,
	repoFullName: string,
	githubLogin: string,
	need: PermissionLevel,
): Promise<boolean> {
	return LEVEL[await repoPermission(env, gh, installationId, repoFullName, githubLogin)] >= LEVEL[need];
}

/** Throws forbidden (403) unless githubLogin's role on the repo, cached up to 5 minutes, is at least need. */
export async function requirePermission(
	env: Env,
	gh: GitHubClient,
	installationId: number,
	repoFullName: string,
	githubLogin: string,
	need: PermissionLevel,
): Promise<void> {
	const permission = await repoPermission(env, gh, installationId, repoFullName, githubLogin);
	if (LEVEL[permission] < LEVEL[need]) {
		throw new HubError("forbidden", 403, `${githubLogin} has ${permission} on ${repoFullName}, needs ${need}`);
	}
}

/**
 * Throws forbidden (403) unless githubLogin is admin or maintain on the repo.
 * Asks GitHub every time, without the permission cache: sink configs carry
 * secrets, so a revoked role must stop the next command or form submission.
 */
export async function requireSinkManager(env: Env, installationId: number, repoFullName: string, githubLogin: string): Promise<void> {
	const [owner = "", repo = ""] = repoFullName.split("/");
	const permission = await getCollaboratorPermission(await commandGitHub(env).installation(installationId), owner, repo, githubLogin);
	if (permission !== "admin" && permission !== "maintain") {
		throw new HubError("forbidden", 403, `${githubLogin} has ${permission} on ${repoFullName}, needs maintain`);
	}
}

/**
 * The checks every repo command makes after requireLinkedUser: the repo is
 * in a linked installation (else repo_not_found) and the user's GitHub role
 * on it is at least need (else forbidden).
 */
export async function requireRepoAccess(
	env: Env,
	teamId: string,
	user: LinkedUser,
	fullName: string,
	need: PermissionLevel,
): Promise<{ repo: ResolvedRepo; gh: GitHubClient }> {
	const repo = await resolveRepo(env, teamId, fullName);
	const gh = commandGitHub(env);
	await requirePermission(env, gh, repo.installationId, repo.fullName, user.githubLogin, need);
	return { repo, gh };
}

/**
 * Whether user administers the installation's account: the owner of a user
 * account, matched by GitHub user id because logins can be renamed and
 * reused, or an admin of an organization. Organization roles are cached like
 * repo roles, up to 5 minutes; fresh looks the role up again. A stale
 * organization login fails closed: GitHub answers 404 for it.
 */
export async function isInstallationAdmin(
	env: Env,
	gh: GitHubClient,
	installation: Pick<InstallationRow, "id" | "account_login" | "account_type" | "account_id">,
	user: LinkedUser,
	fresh = false,
): Promise<boolean> {
	if (installation.account_type === "User") return installation.account_id === user.githubUserId;
	// "@" never appears in a repo name, so the org entry cannot collide with a repo's.
	const role = await cachedPermission(
		installation.id,
		`@org/${installation.account_login}`,
		user.githubLogin,
		(env.__TEST_CLOCK ?? systemClock).now(),
		async () => ((await isOrgAdmin(await gh.installation(installation.id), installation.account_login, user.githubLogin)) ? "admin" : "none"),
		fresh,
	);
	return role === "admin";
}
