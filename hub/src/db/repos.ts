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

/**
 * Forgets repos the installation no longer has access to: their rows,
 * repo_bindings, watches and check_runs. Their runs stay until retention.
 */
export async function removeRepos(t: TenantDb, repoIds: readonly number[]): Promise<void> {
	if (repoIds.length === 0) return;
	const ids = JSON.stringify(repoIds);
	for (const table of ["repo_bindings", "watches", "check_runs", "repos"] as const) {
		await t.run(`DELETE FROM ${table} WHERE installation_id = ?1 AND repo_id IN (SELECT value FROM json_each(?2))`, ids);
	}
}

/** Looks a repo up by `owner/name`, ignoring case as GitHub does. */
export async function getRepoByFullName(t: TenantDb, fullName: string): Promise<RepoRow | null> {
	return t.first<RepoRow>("SELECT * FROM repos WHERE installation_id = ?1 AND full_name = ?2 COLLATE NOCASE", fullName);
}

/** Records the default branch a webhook reports for a known repo, so a renamed one reaches the deploy chain. */
export async function setDefaultBranch(t: TenantDb, repoId: number, branch: string): Promise<void> {
	await t.run("UPDATE repos SET default_branch = ?3 WHERE installation_id = ?1 AND repo_id = ?2 AND default_branch != ?3", repoId, branch);
}

export async function getRepo(t: TenantDb, repoId: number): Promise<RepoRow | null> {
	return t.first<RepoRow>("SELECT * FROM repos WHERE installation_id = ?1 AND repo_id = ?2", repoId);
}

export async function listRepos(t: TenantDb): Promise<RepoRow[]> {
	return t.all<RepoRow>("SELECT * FROM repos WHERE installation_id = ?1 ORDER BY full_name");
}

/**
 * Looks `owner/name` up, ignoring case, among the repos of the live
 * installations linked to the Slack team. Keyed by team across
 * installations, so it takes the raw D1Database.
 */
export async function findRepoForTeam(db: D1Database, teamId: string, fullName: string): Promise<RepoRow | null> {
	return db
		.prepare(
			`SELECT r.* FROM repos r
			JOIN workspace_links l ON l.installation_id = r.installation_id
			JOIN installations i ON i.id = r.installation_id
			WHERE l.team_id = ?1 AND r.full_name = ?2 COLLATE NOCASE AND i.deleted_at IS NULL
			ORDER BY r.installation_id LIMIT 1`,
		)
		.bind(teamId, fullName)
		.first<RepoRow>();
}

/** Position in the (repo_id, installation_id) order listActiveReposAfter walks. */
export type RepoCursor = { repoId: number; installationId: number };

/**
 * Repos of installations that are neither suspended nor deleted, after the
 * cursor in (repo_id, installation_id) order. It reads across installations
 * for the reconcile cron, so it takes the raw D1Database.
 */
export async function listActiveReposAfter(db: D1Database, after: RepoCursor, limit: number): Promise<RepoRow[]> {
	const { results } = await db
		.prepare(
			`SELECT r.* FROM repos r JOIN installations i ON i.id = r.installation_id
			WHERE i.suspended_at IS NULL AND i.deleted_at IS NULL AND (r.repo_id, r.installation_id) > (?1, ?2)
			ORDER BY r.repo_id, r.installation_id LIMIT ?3`,
		)
		.bind(after.repoId, after.installationId, limit)
		.all<RepoRow>();
	return results;
}
