// The fork gate: a fork pull request stops as a gated run until a
// collaborator with write access approves its head SHA, once. Nothing about
// the run reaches the agent before then.

import { getRepo } from "../db/repos";
import { findRunByTrigger, getRun } from "../db/runs";
import { tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { getPull } from "../github/api";
import { GitHubClient } from "../github/client";
import type { HubTrigger } from "../github/normalize";
import { defaultFetcher } from "../http";
import { logEvent } from "../observability";
import type { TriggerRequest } from "../webhook/route";
import { consumeApproval, isApprovalCurrent, recordApproval } from "./approvals";
import { isForkPr, loadForkPolicy } from "./policy";

export type GateReason = "fork_gated" | "fork_never";
export type ApproveOutcome = "dispatched" | "stale" | "already_used" | "not_gated";

async function installationGitHub(env: Env, installationId: number) {
	const clock = env.__TEST_CLOCK ?? systemClock;
	return new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => clock.now()).installation(installationId);
}

/**
 * Records a fork pull request's run as gated on agentId (the agent bound to
 * its repo) instead of triggering it; non-fork triggers pass through.
 */
export async function gateForkRun(
	env: Env,
	trigger: HubTrigger,
	agentId: string,
): Promise<{ gated: false } | { gated: true; runId: string; reason: GateReason }> {
	if (!isForkPr(trigger.pr)) return { gated: false };
	const gh = await installationGitHub(env, trigger.installationId);
	const { policy } = await loadForkPolicy(gh, trigger.repo, trigger.baseSha ?? trigger.defaultBranch);
	const reason: GateReason = policy === "never" ? "fork_never" : "fork_gated";
	const res = await env.AGENT_DO.get(env.AGENT_DO.idFromName(agentId)).fetch("https://do/gate", {
		method: "POST",
		headers: { "x-hookci-agent-id": agentId },
		body: JSON.stringify({ ...trigger, reason }),
	});
	if (!res.ok) throw new HubError("agent_do_failed", 502, `AgentDO /gate answered ${res.status}`);
	const answer = await res.json<{ trigger_id?: string }>();
	return { gated: true, runId: answer.trigger_id ?? "", reason };
}

/**
 * Approves the gated run runId for headSha and dispatches it as untrusted.
 * Stale when headSha is not the run's commit or no longer the pull request
 * head; already_used when this SHA's approval was spent.
 */
export async function approveForkRun(
	env: Env,
	a: { installationId: number; runId: string; headSha: string; approverGithubId: number; approverLogin: string; via: "slack" | "check_run" },
): Promise<ApproveOutcome> {
	const t = tenantDb(env.DB, a.installationId);
	const run = (await getRun(t, a.runId)) ?? (await findRunByTrigger(t, a.runId));
	if (!run || run.pr_number === null || run.agent_id === null) return "not_gated";
	const repo = await getRepo(t, run.repo_id);
	if (!repo) return "not_gated";
	if (a.headSha !== run.sha) return "stale";
	const [owner = "", name = ""] = repo.full_name.split("/");
	const pull = await getPull(await installationGitHub(env, a.installationId), owner, name, run.pr_number);
	if (pull.head.sha !== a.headSha) return "stale";

	const key = { repoId: run.repo_id, prNumber: run.pr_number, headSha: a.headSha, attempt: run.attempt };
	if (run.state !== "gated" || run.reason !== "fork_gated") {
		return (await isApprovalCurrent(t, key, pull.head.sha)) ? "already_used" : "not_gated";
	}
	await recordApproval(t, { ...key, approvedByGithubId: a.approverGithubId });
	if (!(await consumeApproval(t, key))) return "already_used";

	const trigger: TriggerRequest = {
		installationId: a.installationId,
		repoId: run.repo_id,
		repo: repo.full_name,
		sha: run.sha,
		ref: run.ref,
		event: "pull_request",
		pr: { number: pull.number, headRef: pull.head.ref, headRepoFullName: pull.head.repo?.full_name ?? "", fork: true, authorLogin: pull.user.login },
		baseSha: pull.base.sha,
		authorLogin: run.author_login ?? "",
		commitTitle: run.commit_title ?? "",
		defaultBranch: repo.default_branch,
		target: "checks",
		attempt: run.attempt,
		trust: "untrusted",
		runId: run.trigger_id,
		approvedBy: a.approverLogin,
	};
	const res = await env.AGENT_DO.get(env.AGENT_DO.idFromName(run.agent_id)).fetch("https://do/trigger", {
		method: "POST",
		headers: { "x-hookci-agent-id": run.agent_id },
		body: JSON.stringify(trigger),
	});
	if (res.status === 409) {
		const { error } = await res.json<{ error?: string }>();
		if (error === "fork_approval_stale") return "stale";
		if (error === "fork_approval_used") return "already_used";
	}
	if (!res.ok) throw new HubError("agent_do_failed", 502, `AgentDO /trigger answered ${res.status}`);
	logEvent("fork_approved", { installation_id: a.installationId, repo_id: run.repo_id, pr_number: run.pr_number, sha: run.sha, via: a.via, approver: a.approverGithubId });
	return "dispatched";
}
