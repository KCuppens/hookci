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
import { PROVIDER_TIMEOUT_MS } from "../http";
import { logEvent, reportError } from "../observability";
import { fetchRepoConfig, readRepoTriggers } from "../policy/repo-config";
import type { RunView } from "../sinks/types";
import type { TriggerRequest } from "../webhook/route";
import { renderRejected, reopenDeployRender } from "./render";

export interface CheckConclusion {
	installationId: number;
	/** owner/name */
	repo: string;
	sha: string;
	ref: string;
	event: "push" | "pull_request";
	conclusion: CheckRunConclusion;
	/** The checks run that concluded: the deploys fold into its Slack message. */
	checksRunId: string;
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
	/** The checks run whose pass chained the deploy; null for deploys chained before it was recorded. */
	checks_run_id: string | null;
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
	/** The checks run whose pass chained the deploy, carried over to its retries. */
	checksRunId: string | null;
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
	// the agent reports why. If the config cannot be fetched (GitHub down, rate
	// limited or slower than PROVIDER_TIMEOUT_MS) every env goes out and the
	// agent, which reads it again, decides and reports. The full ref keeps a
	// tag named like the default branch from standing in for it.
	let deployBranches: Record<string, string> | null;
	try {
		deployBranches = await readDeployBranches(env, c.installationId, repo.full_name, `refs/heads/${repo.default_branch}`);
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
			checksRunId: c.checksRunId,
		});
		if (!duplicate) sent++;
	}
	return sent;
}

/**
 * The deploy branches `.hookci.yml` names at ref. It runs while an agent's
 * final frame waits for its ack, so it gives up after PROVIDER_TIMEOUT_MS and
 * throws on a rate limit or a 5xx instead of waiting to retry.
 */
async function readDeployBranches(env: Env, installationId: number, repo: string, ref: string): Promise<Record<string, string> | null> {
	const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
	const timedOut = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
	const text = await Promise.race([fetchRepoConfig(env, installationId, repo, ref, { signal, maxAttempts: 1 }), timedOut]);
	return readRepoTriggers(text).deployBranches;
}

/**
 * How long a checks run's final state waits for its deploys: the config read
 * (PROVIDER_TIMEOUT_MS at most) and as long again for the dispatches.
 */
const CHAIN_WAIT_MS = 2 * PROVIDER_TIMEOUT_MS;

/**
 * Starts the chain for a checks run that concluded: in the AgentDO before
 * the run's final state is written, so the Slack message of a push that
 * deploys never shows it passed before its deploys are recorded. Its errors
 * are reported and never stop the run's final state, and after CHAIN_WAIT_MS
 * the final state goes ahead while the dispatches finish on their own: an
 * aborted dispatch could not tell whether its agent got the trigger.
 */
export async function chainDeploys(env: Env, run: RunView, conclusion: CheckRunConclusion): Promise<void> {
	const fields = { installation_id: run.installationId, repo: run.repo, sha: run.sha, op: "deploy_chain" };
	const chain = onCheckConcluded(env, {
		installationId: run.installationId,
		repo: run.repo,
		sha: run.sha,
		ref: run.ref ?? "",
		event: run.event,
		conclusion,
		checksRunId: run.runId ?? run.triggerId,
	}).then(
		(sent) => {
			if (sent > 0) logEvent("deploy_chain_dispatched", { installation_id: run.installationId, repo: run.repo, sha: run.sha, sent });
		},
		(err: unknown) => reportError(err, fields),
	);
	const deadline = AbortSignal.timeout(CHAIN_WAIT_MS);
	const late = new Promise<"late">((resolve) => deadline.addEventListener("abort", () => resolve("late"), { once: true }));
	const outcome = await Promise.race([chain.then(() => "done" as const), late]);
	if (outcome === "late") reportError(new HubError("deploy_chain_slow", 504, `deploy chain still running after ${CHAIN_WAIT_MS} ms`), fields);
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
		`INSERT OR IGNORE INTO deploy_triggers (installation_id, repo, sha, env, attempt, event, ref, trigger_id, agent_id, checks_run_id, status, created_at, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'sent', ?11, ?11)`,
		repo.full_name,
		args.sha,
		args.envName,
		args.attempt,
		args.event,
		args.ref,
		triggerId,
		args.agentId,
		args.checksRunId,
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
 * posts the standalone badge of a rejected one whose push has no checks
 * message (the run's fan-out folds it into that message otherwise); trigger
 * ids that are not the installation's deploy triggers, and replayed replies,
 * change nothing. An
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

/** The highest attempt this installation sent for the commit and env; null when none was. */
export async function latestDeployTrigger(env: Env, installationId: number, repo: string, sha: string, envName: string): Promise<DeployTriggerRow | null> {
	return env.DB.prepare(
		"SELECT * FROM deploy_triggers WHERE installation_id = ?1 AND repo = ?2 COLLATE NOCASE AND sha = ?3 AND env = ?4 ORDER BY attempt DESC LIMIT 1",
	)
		.bind(installationId, repo, sha, envName)
		.first<DeployTriggerRow>();
}
