// The push-to-deploy chain: when the aggregate `hookci` check of a push
// concludes success, every `deploy:<env>` binding of the repo whose
// `deployments.<env>.on.push` on the default branch names the pushed branch
// gets one deploy trigger through its agent's AgentDO, recorded once per
// (repo, sha, env, attempt) in deploy_triggers together with the agent's reply.

import { type BindingRow, deployEnv } from "../db/bindings";
import { getRepoByFullName } from "../db/repos";
import { findLatestRun } from "../db/runs";
import { tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { HubError } from "../errors";
import type { CheckRunConclusion } from "../github/types";
import { reportError } from "../observability";
import { fetchRepoConfig, readRepoTriggers } from "../policy/repo-config";
import { renderRejected, reopenDeployRender } from "./render";
import type { TriggerRequest } from "../webhook/route";

export interface CheckConclusion {
	installationId: number;
	/** owner/name */
	repo: string;
	sha: string;
	ref: string;
	event: "push" | "pull_request";
	conclusion: CheckRunConclusion;
}

export interface DeployTriggerRow {
	installation_id: number;
	repo: string;
	sha: string;
	env: string;
	attempt: number;
	event: "push" | "retry";
	ref: string;
	trigger_id: string;
	agent_id: string;
	run_id: string | null;
	status: "sent" | "accepted" | "rejected";
	reason: string | null;
	created_at: number;
	updated_at: number;
}

export interface DeployDispatch {
	installationId: number;
	/** owner/name */
	repo: string;
	sha: string;
	ref: string;
	envName: string;
	agentId: string;
	event: "push" | "retry";
	attempt: number;
}

export type DeployReply = { type: "accepted"; trigger_id: string; run_id: string } | { type: "rejected"; trigger_id: string; reason: string };

/** Sends the deploy triggers a concluded check calls for; returns how many were sent (duplicates are not). */
export async function onCheckConcluded(env: Env, c: CheckConclusion): Promise<number> {
	if (c.event !== "push" || c.conclusion !== "success") return 0;
	const t = tenantDb(env.DB, c.installationId);
	const repo = await getRepoByFullName(t, c.repo);
	if (!repo) return 0;
	const bindings = await t.all<BindingRow>(
		"SELECT * FROM repo_bindings WHERE installation_id = ?1 AND repo_id = ?2 AND target LIKE 'deploy:%' ORDER BY target",
		repo.repo_id,
	);
	if (bindings.length === 0) return 0;
	// Deploy branches are read on the default branch, like the agent's check, so
	// a pushed commit cannot pick its own. An env that config names no branch
	// for (gone, or the file broken) still goes out on a default-branch push so
	// the agent reports why. If the config cannot be fetched every env goes out
	// and the agent, which reads it again, decides and reports. The full ref
	// keeps a tag named like the default branch from standing in for it.
	let deployBranches: Record<string, string> | null;
	try {
		({ deployBranches } = readRepoTriggers(
			await fetchRepoConfig(env, c.installationId, repo.full_name, `refs/heads/${repo.default_branch}`),
		));
	} catch (err) {
		reportError(err, { installation_id: c.installationId, repo: repo.full_name, sha: c.sha });
		deployBranches = null;
	}
	const branch = c.ref.replace(/^refs\/heads\//, "");
	let sent = 0;
	for (const binding of bindings) {
		const envName = deployEnv(binding.target);
		if (envName === null) continue;
		if (deployBranches !== null && (deployBranches[envName] ?? repo.default_branch) !== branch) continue;
		const { duplicate } = await dispatchDeployTrigger(env, {
			installationId: c.installationId,
			repo: repo.full_name,
			sha: c.sha,
			ref: c.ref,
			envName,
			agentId: binding.agent_id,
			event: "push",
			attempt: 1,
		});
		if (!duplicate) sent++;
	}
	return sent;
}

/**
 * Records the trigger once per (repo, sha, env, attempt) and hands it to the
 * agent's AgentDO, which queues it while the agent is offline. A key already
 * recorded sends nothing and answers duplicate with the recorded trigger id.
 */
export async function dispatchDeployTrigger(env: Env, args: DeployDispatch): Promise<{ triggerId: string; duplicate: boolean }> {
	const t = tenantDb(env.DB, args.installationId);
	const repo = await getRepoByFullName(t, args.repo);
	if (!repo) throw new HubError("repo_not_found", 404, `repo ${args.repo} is not in installation ${args.installationId}`);

	const now = Date.now();
	const triggerId = crypto.randomUUID();
	const inserted = await t.run(
		`INSERT OR IGNORE INTO deploy_triggers (installation_id, repo, sha, env, attempt, event, ref, trigger_id, agent_id, status, created_at, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'sent', ?10, ?10)`,
		repo.full_name,
		args.sha,
		args.envName,
		args.attempt,
		args.event,
		args.ref,
		triggerId,
		args.agentId,
		now,
	);
	if (inserted.meta.changes === 0) {
		const existing = await t.first<{ trigger_id: string }>(
			"SELECT trigger_id FROM deploy_triggers WHERE installation_id = ?1 AND repo = ?2 AND sha = ?3 AND env = ?4 AND attempt = ?5",
			repo.full_name,
			args.sha,
			args.envName,
			args.attempt,
		);
		return { triggerId: existing?.trigger_id ?? triggerId, duplicate: true };
	}

	const ci = await findLatestRun(t, repo.repo_id, args.sha);
	const body: TriggerRequest = {
		installationId: args.installationId,
		repoId: repo.repo_id,
		repo: repo.full_name,
		sha: args.sha,
		ref: args.ref,
		event: "push",
		authorLogin: ci?.author_login ?? "",
		commitTitle: ci?.commit_title ?? "",
		defaultBranch: repo.default_branch,
		target: `deploy:${args.envName}`,
		attempt: args.attempt,
		trust: "trusted",
		triggerId,
		retry: args.event === "retry",
	};
	try {
		const res = await env.AGENT_DO.get(env.AGENT_DO.idFromName(args.agentId)).fetch("https://do/trigger", {
			method: "POST",
			headers: { "x-hookci-agent-id": args.agentId },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new HubError("agent_do_failed", 502, `deploy trigger for ${args.agentId} answered ${res.status}`);
	} catch (err) {
		// Free the key so the next conclusion or retry can send it again.
		await t.run("DELETE FROM deploy_triggers WHERE installation_id = ?1 AND trigger_id = ?2 AND status = 'sent'", triggerId);
		throw err;
	}
	return { triggerId, duplicate: false };
}

/**
 * Stores the agent's reply to one of installationId's deploy triggers and
 * posts the badge of a rejected one; trigger ids that are not the
 * installation's deploy triggers, and replayed replies, change nothing. An
 * accepted retry reuses its run id, so the run's finished render is reopened
 * as queued with a new check run.
 */
export async function recordDeployReply(env: Env, installationId: number, reply: DeployReply): Promise<void> {
	const accepted = reply.type === "accepted";
	const row = await tenantDb(env.DB, installationId).first<DeployTriggerRow>(
		"UPDATE deploy_triggers SET status = ?2, run_id = ?3, reason = ?4, updated_at = ?5 WHERE installation_id = ?1 AND trigger_id = ?6 AND status IS NOT ?2 RETURNING *",
		reply.type,
		accepted ? reply.run_id : null,
		accepted ? null : reply.reason,
		Date.now(),
		reply.trigger_id,
	);
	if (row && !accepted) await renderRejected(env, row);
	if (row && accepted) await reopenDeployRender(env, installationId, reply.run_id, row.agent_id);
}

/** The highest attempt sent for the commit and env; null when none was. */
export async function latestDeployTrigger(env: Env, repo: string, sha: string, envName: string): Promise<DeployTriggerRow | null> {
	return env.DB.prepare("SELECT * FROM deploy_triggers WHERE repo = ?1 COLLATE NOCASE AND sha = ?2 AND env = ?3 ORDER BY attempt DESC LIMIT 1")
		.bind(repo, sha, envName)
		.first<DeployTriggerRow>();
}
