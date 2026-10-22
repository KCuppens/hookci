// Runs a finished run again as the next attempt through the agent bound to its
// target. Shared by the Slack retry command and the dashboard's Retry button.
// No trigger is stored, so it is rebuilt from the D1 run row, the repo row and,
// for pull requests, the pull request on GitHub. A fork pull request's attempt
// passes the fork gate like a new fork run.

import { type BindingTarget, getBinding } from "../db/bindings";
import type { RunRow } from "../db/runs";
import { tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { HubError } from "../errors";
import { gateForkRun } from "../forks/gate";
import { getPull } from "../github/api";
import type { GitHubClient } from "../github/client";
import { loadRunView } from "../sinks/runview";
import type { ResolvedRepo } from "../slack/resolve";
import type { TriggerRequest } from "../webhook/route";

export type RetryOutcome =
	| { kind: "no_agent"; target: BindingTarget }
	| { kind: "fork_never" }
	| { kind: "gated" }
	| { kind: "duplicate" }
	| { kind: "offline" }
	| { kind: "retried"; state: string };

async function rebuildTrigger(gh: GitHubClient, repo: ResolvedRepo, run: RunRow, target: BindingTarget): Promise<TriggerRequest> {
	const base: TriggerRequest = {
		installationId: repo.installationId,
		repoId: repo.repoId,
		repo: repo.fullName,
		sha: run.sha,
		ref: run.ref,
		event: run.event === "pull_request" ? "pull_request" : "push",
		authorLogin: run.author_login ?? "",
		commitTitle: run.commit_title ?? "",
		defaultBranch: repo.defaultBranch,
		target,
		attempt: run.attempt + 1,
		trust: "trusted",
	};
	if (run.event !== "pull_request" || run.pr_number === null) return base;
	const [owner = "", name = ""] = repo.fullName.split("/");
	const pull = await getPull(await gh.installation(repo.installationId), owner, name, run.pr_number);
	const headRepoFullName = pull.head.repo?.full_name ?? "";
	const fork = headRepoFullName.toLowerCase() !== repo.fullName.toLowerCase();
	return {
		...base,
		pr: { number: pull.number, headRef: pull.head.ref, headRepoFullName, fork, authorLogin: pull.user.login },
		baseSha: pull.base.sha,
		trust: fork ? "untrusted" : "trusted",
	};
}

async function agentOnline(env: Env, agentId: string): Promise<boolean> {
	const res = await env.AGENT_DO.get(env.AGENT_DO.idFromName(agentId)).fetch("https://do/status");
	if (!res.ok) throw new HubError("agent_do_failed", 502, `status of ${agentId} answered ${res.status}`);
	return (await res.json<{ online: boolean }>()).online;
}

/** Triggers attempt run.attempt + 1 of the run; the caller has checked the user may write to the repo. */
export async function retryRun(env: Env, gh: GitHubClient, repo: ResolvedRepo, run: RunRow): Promise<RetryOutcome> {
	const t = tenantDb(env.DB, repo.installationId);
	const target: BindingTarget = run.env === null ? "checks" : `deploy:${run.env}`;
	const binding = await getBinding(t, repo.repoId, target);
	if (!binding) return { kind: "no_agent", target };
	const trigger = await rebuildTrigger(gh, repo, run, target);
	const gate = await gateForkRun(env, trigger, binding.agent_id);
	if (gate.gated) return { kind: gate.reason === "fork_never" ? "fork_never" : "gated" };
	const res = await env.AGENT_DO.get(env.AGENT_DO.idFromName(binding.agent_id)).fetch("https://do/trigger", {
		method: "POST",
		headers: { "x-hookci-agent-id": binding.agent_id },
		body: JSON.stringify(trigger),
	});
	if (!res.ok) throw new HubError("agent_do_failed", 502, `trigger for ${binding.agent_id} answered ${res.status}`);
	const answer = await res.json<{ trigger_id?: string; duplicate?: boolean }>();
	if (answer.duplicate || !answer.trigger_id) return { kind: "duplicate" };
	if (!(await agentOnline(env, binding.agent_id))) return { kind: "offline" };
	const view = await loadRunView(env.DB, repo.installationId, { triggerId: answer.trigger_id });
	return { kind: "retried", state: view?.state ?? "received" };
}
