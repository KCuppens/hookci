import { GitHubApiError, type GitHubRequester } from "./client";
import type {
	CheckRun,
	CollaboratorPermission,
	Commit,
	CommitSummary,
	CreateCheckRunBody,
	Installation,
	PullRequest,
	RepoPermission,
	Repository,
	UpdateCheckRunBody,
	User,
} from "./types";

const PER_PAGE = 100;

const ROLES: readonly RepoPermission[] = ["admin", "maintain", "write", "triage", "read"];

/** Collects a list endpoint page by page; key names the array in each page's body. */
async function paginate<K extends string, T>(gh: GitHubRequester, path: string, key: K): Promise<T[]> {
	const items: T[] = [];
	for (let page = 1; ; page++) {
		const res = await gh.request<Record<K, T[]>>("GET", `${path}?per_page=${PER_PAGE}&page=${page}`);
		const batch = res.data[key];
		items.push(...batch);
		if (batch.length < PER_PAGE) return items;
	}
}

const repoPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

/**
 * The user's role on the repository; "none" when GitHub does not know the
 * user or the repository. Custom organization roles map to their base
 * permission.
 */
export async function getCollaboratorPermission(
	inst: GitHubRequester,
	owner: string,
	repo: string,
	login: string,
): Promise<RepoPermission> {
	try {
		const res = await inst.request<CollaboratorPermission>(
			"GET",
			`${repoPath(owner, repo)}/collaborators/${encodeURIComponent(login)}/permission`,
		);
		const { role_name, permission } = res.data;
		return ROLES.find((r) => r === role_name) ?? permission;
	} catch (err) {
		if (err instanceof GitHubApiError && err.githubStatus === 404) return "none";
		throw err;
	}
}

/** Installations of this app the user can access (user-to-server token). */
export function listUserInstallations(user: GitHubRequester): Promise<Installation[]> {
	return paginate<"installations", Installation>(user, "/user/installations", "installations");
}

export async function getUser(user: GitHubRequester): Promise<User> {
	return (await user.request<User>("GET", "/user")).data;
}

/** Revokes a user-to-server token (oauthApp requester); a token GitHub no longer knows (404) counts as revoked. */
export async function deleteUserToken(oauthApp: GitHubRequester, clientId: string, userToken: string): Promise<void> {
	try {
		await oauthApp.request("DELETE", `/applications/${clientId}/token`, { access_token: userToken });
	} catch (err) {
		if (err instanceof GitHubApiError && err.githubStatus === 404) return;
		throw err;
	}
}

/** Repositories the installation token can access. */
export function listInstallationRepos(inst: GitHubRequester): Promise<Repository[]> {
	return paginate<"repositories", Repository>(inst, "/installation/repositories", "repositories");
}

export async function getCommit(
	inst: GitHubRequester,
	owner: string,
	repo: string,
	sha: string,
): Promise<CommitSummary> {
	const { data } = await inst.request<Commit>("GET", `${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}`);
	return {
		sha: data.sha,
		authorEmail: data.commit.author?.email ?? null,
		authorLogin: data.author?.login ?? null,
		title: data.commit.message.split("\n", 1)[0] ?? "",
	};
}

export async function getPull(inst: GitHubRequester, owner: string, repo: string, n: number): Promise<PullRequest> {
	return (await inst.request<PullRequest>("GET", `${repoPath(owner, repo)}/pulls/${n}`)).data;
}

export async function createCheckRun(
	inst: GitHubRequester,
	owner: string,
	repo: string,
	body: CreateCheckRunBody,
): Promise<CheckRun> {
	return (await inst.request<CheckRun>("POST", `${repoPath(owner, repo)}/check-runs`, body)).data;
}

export async function updateCheckRun(
	inst: GitHubRequester,
	owner: string,
	repo: string,
	checkRunId: number,
	body: UpdateCheckRunBody,
): Promise<CheckRun> {
	return (await inst.request<CheckRun>("PATCH", `${repoPath(owner, repo)}/check-runs/${checkRunId}`, body)).data;
}
