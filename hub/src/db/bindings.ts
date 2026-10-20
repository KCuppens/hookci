import type { TenantDb } from "./tenant";

export type BindingTarget = "checks" | `deploy:${string}`;

const DEPLOY_PREFIX = "deploy:";

/** The environment a `deploy:<env>` target deploys to; null for `checks`. */
export function deployEnv(target: BindingTarget): string | null {
	return target.startsWith(DEPLOY_PREFIX) ? target.slice(DEPLOY_PREFIX.length) : null;
}

export interface BindingRow {
	installation_id: number;
	repo_id: number;
	target: BindingTarget;
	agent_id: string;
}

/** Routes target work for the repo to agentId, replacing any previous agent. */
export async function bind(t: TenantDb, repoId: number, target: BindingTarget, agentId: string): Promise<void> {
	await t.run(
		`INSERT INTO repo_bindings (installation_id, repo_id, target, agent_id) VALUES (?1, ?2, ?3, ?4)
		ON CONFLICT (installation_id, repo_id, target) DO UPDATE SET agent_id = excluded.agent_id`,
		repoId,
		target,
		agentId,
	);
}

export async function getBinding(t: TenantDb, repoId: number, target: BindingTarget): Promise<BindingRow | null> {
	return t.first<BindingRow>(
		"SELECT * FROM repo_bindings WHERE installation_id = ?1 AND repo_id = ?2 AND target = ?3",
		repoId,
		target,
	);
}

export async function listBindingsForAgent(t: TenantDb, agentId: string): Promise<BindingRow[]> {
	return t.all<BindingRow>(
		"SELECT * FROM repo_bindings WHERE installation_id = ?1 AND agent_id = ?2 ORDER BY repo_id, target",
		agentId,
	);
}

/** Binds every repo of the installation to agentId for target (default `checks`). */
export async function bindAllRepos(t: TenantDb, agentId: string, target: BindingTarget = "checks"): Promise<void> {
	await t.run(
		`INSERT INTO repo_bindings (installation_id, repo_id, target, agent_id)
		SELECT installation_id, repo_id, ?3, ?2 FROM repos WHERE installation_id = ?1
		ON CONFLICT (installation_id, repo_id, target) DO UPDATE SET agent_id = excluded.agent_id`,
		agentId,
		target,
	);
}
