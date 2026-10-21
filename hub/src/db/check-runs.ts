import type { TenantDb } from "./tenant";

export interface CheckRunRow {
	installation_id: number;
	repo_id: number;
	head_sha: string;
	name: string;
	check_run_id: number;
}

/** The GitHub check run id HookCI created for name on the commit, if any. */
export async function getCheckRun(t: TenantDb, repoId: number, headSha: string, name: string): Promise<number | null> {
	const row = await t.first<Pick<CheckRunRow, "check_run_id">>(
		"SELECT check_run_id FROM check_runs WHERE installation_id = ?1 AND repo_id = ?2 AND head_sha = ?3 AND name = ?4",
		repoId,
		headSha,
		name,
	);
	return row?.check_run_id ?? null;
}

/** Records the check run id for name on the commit, replacing an earlier one. */
export async function putCheckRun(t: TenantDb, row: Omit<CheckRunRow, "installation_id">): Promise<void> {
	await t.run(
		`INSERT INTO check_runs (installation_id, repo_id, head_sha, name, check_run_id) VALUES (?1, ?2, ?3, ?4, ?5)
		ON CONFLICT (installation_id, repo_id, head_sha, name) DO UPDATE SET check_run_id = excluded.check_run_id`,
		row.repo_id,
		row.head_sha,
		row.name,
		row.check_run_id,
	);
}
