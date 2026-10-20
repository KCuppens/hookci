// The Retry button on a failed deploy badge. Its value names the run and the
// attempt it failed on: `<run_id>:<attempt>`. A click by a linked user with
// write access sends the next attempt to the env's deploy agent; the agent
// decides whether the run is retryable.

import { getBinding } from "../db/bindings";
import { getRepoByFullName } from "../db/repos";
import { tenantDb } from "../db/tenant";
import { listLinkedInstallationIds } from "../db/workspaces";
import type { Env } from "../env";
import { HubError } from "../errors";
import { getLinkedUser } from "../identity/link";
import { logEvent } from "../observability";
import { ephemeral } from "../slack/commands/common";
import type { SlackActionCtx, SlackReply } from "../slack/registry";
import { commandGitHub, requirePermission } from "../slack/resolve";
import { S } from "../strings";
import { type DeployTriggerRow, dispatchDeployTrigger, latestDeployTrigger } from "./chain";
import { getDeployRender } from "./render";

export type SlackBlockActionPayload = Pick<SlackActionCtx, "teamId" | "userId" | "value">;
export type SlackEphemeral = SlackReply;

/** Handles one Retry click; null once the next attempt is sent, since the new run's badge is the answer. */
export async function handleDeployRetry(env: Env, payload: SlackBlockActionPayload): Promise<SlackEphemeral | null> {
	const { teamId, userId, value } = payload;
	const user = await getLinkedUser(env, teamId, userId);
	if (!user) return ephemeral(S.slack.notLinked);

	const sep = value.lastIndexOf(":");
	const runId = value.slice(0, Math.max(sep, 0));
	const attempt = Number(value.slice(sep + 1));
	const linked = await listLinkedInstallationIds(env.DB, teamId);
	// Only the linked installations' deploys: the run id comes from the button value.
	const trigger = runId
		? await env.DB.prepare(
				"SELECT * FROM deploy_triggers WHERE run_id = ?1 AND installation_id IN (SELECT value FROM json_each(?2)) ORDER BY attempt DESC LIMIT 1",
			)
				.bind(runId, JSON.stringify(linked))
				.first<DeployTriggerRow>()
		: null;
	const render = trigger && (await getDeployRender(tenantDb(env.DB, trigger.installation_id), runId));
	if (!trigger || !render || trigger.attempt !== attempt) {
		logEvent("tenant_denied", { team_id: teamId, slack_user_id: userId, run_id: runId, reason: "deploy_run_not_linked" });
		return ephemeral(S.deploy.retryNoRun);
	}

	try {
		await requirePermission(env, commandGitHub(env), trigger.installation_id, render.repo, user.githubLogin, "write");
	} catch (err) {
		if (err instanceof HubError && err.code === "forbidden") return ephemeral(S.deploy.retryForbidden(render.repo));
		throw err;
	}

	const latest = await latestDeployTrigger(env, render.repo, render.sha, render.env);
	if (!latest || attempt < latest.attempt) return ephemeral(S.deploy.retryAlreadyRequested);

	const t = tenantDb(env.DB, trigger.installation_id);
	const repo = await getRepoByFullName(t, render.repo);
	if (!repo) return ephemeral(S.deploy.retryNoRun);
	const target = `deploy:${render.env}` as const;
	const binding = await getBinding(t, repo.repo_id, target);
	if (!binding) return ephemeral(S.slack.retryNoAgent(render.repo, target));

	const { duplicate } = await dispatchDeployTrigger(env, {
		installationId: trigger.installation_id,
		repo: render.repo,
		sha: render.sha,
		ref: trigger.ref,
		envName: render.env,
		agentId: binding.agent_id,
		event: "retry",
		attempt: latest.attempt + 1,
	});
	return duplicate ? ephemeral(S.deploy.retryAlreadyRequested) : null;
}
