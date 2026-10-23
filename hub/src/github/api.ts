import { GitHubApiError, type GitHubRequester } from "./client";
import type {
	Branch,
	BranchHead,
	CheckRun,
	CollaboratorPermission,
	Commit,
	CommitChanges,
	CommitFile,
	CommitSummary,
	CreateCheckRunBody,
	HookDelivery,
	Installation,
	OrgMembership,
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

/** Whether login is an active admin of org; false when GitHub does not know the membership (404). */
export async function isOrgAdmin(inst: GitHubRequester, org: string, login: string): Promise<boolean> {
	try {
		const res = await inst.request<OrgMembership>("GET", `/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(login)}`);
		return res.data.state === "active" && res.data.role === "admin";
	} catch (err) {
		if (err instanceof GitHubApiError && err.githubStatus === 404) return false;
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

/** The repository with id repoId as the installation sees it; null when GitHub does not show it to the installation (404). */
export async function getRepository(inst: GitHubRequester, repoId: number): Promise<Repository | null> {
	try {
		return (await inst.request<Repository>("GET", `/repositories/${repoId}`)).data;
	} catch (err) {
		if (err instanceof GitHubApiError && err.githubStatus === 404) return null;
		throw err;
	}
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

/** What the commit changes, as GitHub lists it (at most 300 files, each with its added and removed line counts), and when it was authored. */
export async function getCommitChanges(inst: GitHubRequester, owner: string, repo: string, sha: string): Promise<CommitChanges> {
	const { data } = await inst.request<Commit & { files?: CommitFile[] }>("GET", `${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}`);
	const date = data.commit.author?.date;
	const at = date === undefined ? Number.NaN : Date.parse(date);
	return {
		committedAt: Number.isNaN(at) ? null : at,
		files: (data.files ?? []).map(({ filename, additions, deletions }) => ({ filename, additions, deletions })),
	};
}

/** The branch's head commit, with the time it was committed. */
export async function getBranch(inst: GitHubRequester, owner: string, repo: string, branch: string): Promise<BranchHead> {
	const { data } = await inst.request<Branch>("GET", `${repoPath(owner, repo)}/branches/${encodeURIComponent(branch)}`);
	const { commit } = data;
	const date = commit.commit.committer?.date ?? commit.commit.author?.date;
	if (date === undefined) throw new GitHubApiError(502, `GitHub branch ${owner}/${repo}@${branch}: head commit has no date`);
	return {
		sha: commit.sha,
		authorEmail: commit.commit.author?.email ?? null,
		authorLogin: commit.author?.login ?? null,
		title: commit.commit.message.split("\n", 1)[0] ?? "",
		committedAt: Date.parse(date),
	};
}

/**
 * One page of the app's webhook deliveries, newest first (app requester).
 * next is the cursor of the following page, null on the last.
 */
export async function listHookDeliveries(
	app: GitHubRequester,
	cursor?: string,
): Promise<{ deliveries: HookDelivery[]; next: string | null }> {
	const query = new URLSearchParams({ per_page: String(PER_PAGE) });
	if (cursor !== undefined) query.set("cursor", cursor);
	const res = await app.request<HookDelivery[]>("GET", `/app/hook/deliveries?${query}`);
	const nextUrl = /<([^>]+)>;\s*rel="next"/.exec(res.link ?? "")?.[1];
	return { deliveries: res.data, next: nextUrl === undefined ? null : new URL(nextUrl).searchParams.get("cursor") };
}

/** Asks GitHub to send a webhook delivery again (app requester); it arrives under the same guid. */
export async function redeliverHook(app: GitHubRequester, deliveryId: number): Promise<void> {
	await app.request("POST", `/app/hook/deliveries/${deliveryId}/attempts`);
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
