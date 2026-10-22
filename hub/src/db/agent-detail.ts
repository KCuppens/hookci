// What the agent pages read beyond the agent row itself: the repositories an
// agent runs, who paired it, and the repositories still free to bind.

import type { TenantDb } from "./tenant";

export interface AgentBindingRow {
	repo_id: number;
	/** The repository's full name, null when the repo row is gone. */
	full_name: string | null;
	default_branch: string | null;
	/** `checks` or `deploy:<env>`. */
	target: string;
	/** Epoch ms the binding was made; null for bindings that predate the column. */
	bound_at: number | null;
}

export async function listAgentBindingRows(t: TenantDb, agentId: string): Promise<AgentBindingRow[]> {
	return t.all<AgentBindingRow>(
		`SELECT b.repo_id, r.full_name, r.default_branch, b.target, b.bound_at
		FROM repo_bindings b LEFT JOIN repos r ON r.installation_id = b.installation_id AND r.repo_id = b.repo_id
		WHERE b.installation_id = ?1 AND b.agent_id = ?2 ORDER BY r.full_name, b.target`,
		agentId,
	);
}

/** The GitHub login a Slack workspace member linked for githubUserId, newest link first; null when none. */
export async function linkedLoginOf(t: TenantDb, githubUserId: number): Promise<string | null> {
	const row = await t.first<{ github_login: string }>(
		`SELECT github_login FROM user_links
		WHERE github_user_id = ?2 AND team_id IN (SELECT team_id FROM workspace_links WHERE installation_id = ?1)
		ORDER BY created_at DESC LIMIT 1`,
		githubUserId,
	);
	return row?.github_login ?? null;
}

/** How many non-revoked agents were paired at or after since (epoch ms). */
export async function countAgentsPairedSince(t: TenantDb, since: number): Promise<number> {
	const row = await t.first<{ n: number }>(
		"SELECT count(*) AS n FROM agents WHERE installation_id = ?1 AND revoked_at IS NULL AND paired_at >= ?2",
		since,
	);
	return row?.n ?? 0;
}
