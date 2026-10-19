import type { TenantDb } from "./tenant";

export interface RepoRow {
	installation_id: number;
	repo_id: number;
	full_name: string;
	default_branch: string;
}

export type NewRepo = Omit<RepoRow, "installation_id">;

/** Inserts the repos or refreshes their name and default branch, in one statement. */
export async function upsertRepos(t: TenantDb, repos: readonly NewRepo[]): Promise<void> {
	if (repos.length === 0) return;
	await t.run(
		`INSERT INTO repos (installation_id, repo_id, full_name, default_branch)
		SELECT ?1, json_extract(value, '$.repo_id'), json_extract(value, '$.full_name'), json_extract(value, '$.default_branch')
		FROM json_each(?2) WHERE true
		ON CONFLICT (installation_id, repo_id) DO UPDATE SET full_name = excluded.full_name, default_branch = excluded.default_branch`,
		JSON.stringify(repos),
	);
}

export async function removeRepos(t: TenantDb, repoIds: readonly number[]): Promise<void> {
	if (repoIds.length === 0) return;
	await t.run(
		"DELETE FROM repos WHERE installation_id = ?1 AND repo_id IN (SELECT value FROM json_each(?2))",
		JSON.stringify(repoIds),
	);
}

/** Looks a repo up by `owner/name`, ignoring case as GitHub does. */
export async function getRepoByFullName(t: TenantDb, fullName: string): Promise<RepoRow | null> {
	return t.first<RepoRow>("SELECT * FROM repos WHERE installation_id = ?1 AND full_name = ?2 COLLATE NOCASE", fullName);
}

export async function listRepos(t: TenantDb): Promise<RepoRow[]> {
	return t.all<RepoRow>("SELECT * FROM repos WHERE installation_id = ?1 ORDER BY full_name");
}
