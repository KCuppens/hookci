// /zeroci retry <owner/repo> [sha]: runs the repo's latest run, or the
// latest run of the commit, again as the next attempt through the bound
// agent's AgentDO. No trigger is stored, so the trigger is rebuilt from the
// D1 run row, the repo row and, for pull requests, the pull request on GitHub.

import { type BindingTarget, getBinding } from "../../db/bindings";
import { findLatestRun, type RunRow } from "../../db/runs";
import { tenantDb } from "../../db/tenant";
import type { Env } from "../../env";
import { HubError } from "../../errors";
import { getPull } from "../../github/api";
import type { GitHubClient } from "../../github/client";
import { requireLinkedUser } from "../../identity/link";
import { loadRunView } from "../../sinks/runview";
import { S } from "../../strings";
import type { TriggerRequest } from "../../webhook/route";
import { registerCommand } from "../registry";
import { requireRepoAccess, type ResolvedRepo } from "../resolve";
import { commandArgs, ephemeral } from "./common";

const SHA = /^[0-9a-f]{7,40}$/i;

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

registerCommand("retry", async ({ env, teamId, userId, text }) => {
	const user = await requireLinkedUser(env, teamId, userId);
	const [fullName, sha, ...rest] = commandArgs(text);
	if (!fullName || rest.length > 0 || (sha !== undefined && !SHA.test(sha))) return ephemeral(S.slack.usage("/zeroci retry <owner/repo> [sha]"));
	const { repo, gh } = await requireRepoAccess(env, teamId, user, fullName, "write");
	const t = tenantDb(env.DB, repo.installationId);
	const run = await findLatestRun(t, repo.repoId, sha);
	if (!run) return ephemeral(S.slack.retryNoRun(repo.fullName, sha));
	const target: BindingTarget = run.env === null ? "checks" : `deploy:${run.env}`;
	const binding = await getBinding(t, repo.repoId, target);
	if (!binding) return ephemeral(S.slack.retryNoAgent(repo.fullName, target));

	const trigger = await rebuildTrigger(gh, repo, run, target);
	const res = await env.AGENT_DO.get(env.AGENT_DO.idFromName(binding.agent_id)).fetch("https://do/trigger", {
		method: "POST",
		headers: { "x-zeroci-agent-id": binding.agent_id },
		body: JSON.stringify(trigger),
	});
	if (!res.ok) throw new HubError("agent_do_failed", 502, `trigger for ${binding.agent_id} answered ${res.status}`);
	const answer = await res.json<{ trigger_id?: string; duplicate?: boolean }>();
	const shortSha = run.sha.slice(0, 7);
	const attempt = run.attempt + 1;
	if (answer.duplicate || !answer.trigger_id) return ephemeral(S.slack.retryDuplicate(repo.fullName, shortSha, attempt));
	if (!(await agentOnline(env, binding.agent_id))) return ephemeral(S.slack.retryOffline(repo.fullName, shortSha, attempt));
	const view = await loadRunView(env.DB, repo.installationId, { triggerId: answer.trigger_id });
	return ephemeral(S.slack.retried(repo.fullName, shortSha, attempt, view?.state ?? "received"));
});
