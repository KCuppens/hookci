// Fork run approvals: one per repo, pull request, head SHA and attempt, spent
// by the run it dispatches. A new push changes the head SHA, so older
// approvals never match again; a retry is a new attempt that needs its own.

import type { TenantDb } from "../db/tenant";
import type { Env } from "../env";

export interface ApprovalKey {
	repoId: number;
	prNumber: number;
	headSha: string;
	attempt: number;
}

/** Records the approval; an approval already recorded for the key is kept as it is. */
export async function recordApproval(db: TenantDb, a: ApprovalKey & { approvedByGithubId: number }): Promise<void> {
	await db.run(
		`INSERT INTO fork_approvals (installation_id, repo_id, pr_number, head_sha, attempt, approved_by_github_id, approved_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING`,
		a.repoId,
		a.prNumber,
		a.headSha,
		a.attempt,
		a.approvedByGithubId,
		Date.now(),
	);
}

/** Spends the approval; true only for the one caller that spent it. */
export async function consumeApproval(db: TenantDb, k: ApprovalKey): Promise<boolean> {
	const res = await db.run(
		`UPDATE fork_approvals SET used_at = ?6
		WHERE installation_id = ?1 AND repo_id = ?2 AND pr_number = ?3 AND head_sha = ?4 AND attempt = ?5 AND used_at IS NULL`,
		k.repoId,
		k.prNumber,
		k.headSha,
		k.attempt,
		Date.now(),
	);
	return res.meta.changes === 1;
}

/** Gives back a spent approval whose dispatch failed, so the approver can approve again. */
export async function releaseApproval(db: TenantDb, k: ApprovalKey): Promise<void> {
	await db.run(
		"UPDATE fork_approvals SET used_at = NULL WHERE installation_id = ?1 AND repo_id = ?2 AND pr_number = ?3 AND head_sha = ?4 AND attempt = ?5",
		k.repoId,
		k.prNumber,
		k.headSha,
		k.attempt,
	);
}

/** Whether an approval exists for the key. */
export async function isApprovalRecorded(db: TenantDb, k: ApprovalKey): Promise<boolean> {
	const row = await db.first<{ head_sha: string }>(
		"SELECT head_sha FROM fork_approvals WHERE installation_id = ?1 AND repo_id = ?2 AND pr_number = ?3 AND head_sha = ?4 AND attempt = ?5",
		k.repoId,
		k.prNumber,
		k.headSha,
		k.attempt,
	);
	return row !== null;
}

/** Revoke hook: drops the user's unspent approvals in every installation; returns how many. */
export async function deleteApprovalsByUser(env: Env, githubUserId: number): Promise<number> {
	const res = await env.DB.prepare("DELETE FROM fork_approvals WHERE approved_by_github_id = ?1 AND used_at IS NULL").bind(githubUserId).run();
	return res.meta.changes;
}
