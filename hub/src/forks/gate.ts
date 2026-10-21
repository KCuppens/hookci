// The fork gate: a fork pull request stops as a gated run until a
// collaborator with write access approves its head SHA, once. Nothing about
// the run reaches the agent before then. Only an honored `trust: all` lets a
// fork through ungated, and then it still runs untrusted.

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
import { effectiveTrust, readBaseConfig } from "../policy/trust";
import type { TriggerRequest } from "../webhook/route";
import { consumeApproval, isApprovalRecorded, recordApproval, releaseApproval } from "./approvals";
import { isForkPr } from "./policy";

export type GateReason = "fork_gated" | "fork_never";
export type ApproveOutcome = "dispatched" | "stale" | "already_used" | "not_gated";

async function installationGitHub(env: Env, installationId: number) {
	const clock = env.__TEST_CLOCK ?? systemClock;
	return new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => clock.now()).installation(installationId);
}

/**
 * Records a fork pull request's run as gated on agentId (the agent bound to
 * its repo) instead of triggering it; non-fork triggers, and forks whose base
 * ref's `trust: all` is honored, pass through. `forks: never` always gates.
 * baseConfig is the `.hookci.yml` text at triggerConfigRef(trigger), the base
 * ref for a fork; it is not read for other triggers.
 */
export async function gateForkRun(
	env: Env,
	trigger: HubTrigger,
	agentId: string,
	baseConfig: string | null,
): Promise<{ gated: false } | { gated: true; runId: string; reason: GateReason }> {
	if (!isForkPr(trigger.pr)) return { gated: false };
	const cfg = readBaseConfig(baseConfig);
	const trust = await effectiveTrust(env, tenantDb(env.DB, trigger.installationId), trigger.repoId, cfg.trust);
	if (trust.refused !== null) logEvent("trust_all_refused", { repo: trigger.repo, refused: trust.refused });
	if (cfg.forks !== "never" && trust.effective === "all") return { gated: false };
	const reason: GateReason = cfg.forks === "never" ? "fork_never" : "fork_gated";
	const res = await env.AGENT_DO.get(env.AGENT_DO.idFromName(agentId)).fetch("https://do/gate", {
		method: "POST",
		headers: { "x-hookci-agent-id": agentId },
		body: JSON.stringify({ ...trigger, reason, trustRefused: trust.refused }),
	});
	if (!res.ok) throw new HubError("agent_do_failed", 502, `AgentDO /gate answered ${res.status}`);
	const answer = await res.json<{ trigger_id?: unknown }>();
	if (typeof answer.trigger_id !== "string" || answer.trigger_id === "") {
		throw new HubError("agent_do_failed", 502, "AgentDO /gate answered no trigger_id");
	}
	return { gated: true, runId: answer.trigger_id, reason };
}

/**
 * Approves the gated run runId for headSha and dispatches it as untrusted.
 * Stale when headSha is not the run's commit or no longer the pull request
 * head; already_used when this SHA's approval was spent. The approval stays
 * spent only once the AgentDO took the run; a failed dispatch gives it back.
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
		return (await isApprovalRecorded(t, key)) ? "already_used" : "not_gated";
	}
	await recordApproval(t, { ...key, approvedByGithubId: a.approverGithubId });
	if (!(await consumeApproval(t, key))) return "already_used";
	try {
		const outcome = await dispatchApproved(env, run.agent_id, {
			installationId: a.installationId,
			repoId: run.repo_id,
			repo: repo.full_name,
			sha: run.sha,
			ref: run.ref,
			event: "pull_request",
			pr: { number: pull.number, headRef: pull.head.ref, baseRef: pull.base.ref, headRepoFullName: pull.head.repo?.full_name ?? "", fork: true, authorLogin: pull.user.login },
			baseSha: pull.base.sha,
			authorLogin: run.author_login ?? "",
			commitTitle: run.commit_title ?? "",
			defaultBranch: repo.default_branch,
			target: "checks",
			attempt: run.attempt,
			trust: "untrusted",
			runId: run.trigger_id,
			approvedBy: a.approverLogin,
		});
		// fork_approval_used: the AgentDO already released this run, so the approval stays spent.
		if (outcome !== "dispatched" && outcome !== "already_used") await releaseApproval(t, key);
		if (outcome === "dispatched") {
			logEvent("fork_approved", { installation_id: a.installationId, repo_id: run.repo_id, pr_number: run.pr_number, sha: run.sha, via: a.via, approver: a.approverGithubId });
		}
		return outcome;
	} catch (err) {
		await releaseApproval(t, key);
		throw err;
	}
}

/** Sends the approved trigger to agentId's AgentDO; throws agent_do_failed on any answer it cannot read as an outcome. */
async function dispatchApproved(env: Env, agentId: string, trigger: TriggerRequest): Promise<"dispatched" | "stale" | "already_used"> {
	const res = await env.AGENT_DO.get(env.AGENT_DO.idFromName(agentId)).fetch("https://do/trigger", {
		method: "POST",
		headers: { "x-hookci-agent-id": agentId },
		body: JSON.stringify(trigger),
	});
	if (res.status === 409) {
		const { error } = await res.json<{ error?: string }>();
		if (error === "fork_approval_stale") return "stale";
		if (error === "fork_approval_used") return "already_used";
	}
	if (!res.ok) throw new HubError("agent_do_failed", 502, `AgentDO /trigger answered ${res.status}`);
	return "dispatched";
}
