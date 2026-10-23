// App Home buttons. Add agent and Revoke carry the installation id as value
// and re-check, uncached, that the caller administers that installation.

import { getAgent } from "../../db/agents";
import { getInstallation, type InstallationRow } from "../../db/installations";
import { tenantDb } from "../../db/tenant";
import { listLinkedInstallationIds } from "../../db/workspaces";
import type { Env } from "../../env";
import { HubError } from "../../errors";
import { getLinkedUser, type LinkedUser } from "../../identity/link";
import { logEvent } from "../../observability";
import { revokeAgent } from "../../pairing/agents";
import { createPairToken } from "../../pairing/tokens";
import { S } from "../../strings";
import { slackApi } from "../api";
import { ephemeral } from "../commands/common";
import { publishHome } from "../home";
import { type SlackReply, registerAction } from "../registry";
import { commandGitHub, isInstallationAdmin } from "../resolve";
import { pairTokenModal } from "../views";

/** The installation named by value when it is linked to the team and user administers it, else the refusal. */
async function adminInstallation(env: Env, teamId: string, user: LinkedUser, value: string): Promise<InstallationRow | SlackReply> {
	const id = Number(value);
	const linked = Number.isSafeInteger(id) && (await listLinkedInstallationIds(env.DB, teamId)).includes(id);
	const installation = linked ? await getInstallation(env.DB, id) : null;
	if (!installation) {
		logEvent("tenant_denied", { team_id: teamId, github_login: user.githubLogin, installation_id: id, reason: "installation_not_linked" });
		return ephemeral(S.slack.forbidden);
	}
	if (!(await isInstallationAdmin(env, commandGitHub(env), installation, user, true))) return ephemeral(S.slack.forbidden);
	return installation;
}

registerAction("home:add_agent", async ({ env, teamId, userId, value, triggerId }) => {
	const user = await getLinkedUser(env, teamId, userId);
	if (!user) return ephemeral(S.slack.notLinked);
	const installation = await adminInstallation(env, teamId, user, value);
	if (!("id" in installation)) return installation;
	let pair: { token: string; expiresAt: number };
	try {
		pair = await createPairToken(env, { installationId: installation.id, createdByGithubId: user.githubUserId });
	} catch (err) {
		if (err instanceof HubError && err.code === "pair_rate_limited") return ephemeral(S.slack.slowDown);
		throw err;
	}
	const view = pairTokenModal(pair.token, `${env.HUB_ORIGIN}/install`, pair.expiresAt, env.LATEST_AGENT_VERSION);
	await slackApi(env, teamId, "views.open", { trigger_id: triggerId, view });
	return null;
});

registerAction("home:revoke_agent", async ({ env, teamId, userId, actionId, value }) => {
	const user = await getLinkedUser(env, teamId, userId);
	if (!user) return ephemeral(S.slack.notLinked);
	const installation = await adminInstallation(env, teamId, user, value);
	if (!("id" in installation)) return installation;
	const agentId = actionId.slice("home:revoke_agent:".length);
	const agent = await getAgent(tenantDb(env.DB, installation.id), agentId);
	if (!agent) {
		logEvent("tenant_denied", { team_id: teamId, installation_id: installation.id, agent_id: agentId, reason: "agent_not_found" });
		return ephemeral(S.slack.forbidden);
	}
	await revokeAgent(env, agent.agent_id, "revoked");
	await publishHome(env, teamId, userId);
	return null;
});

registerAction("home:refresh", async ({ env, teamId, userId }) => {
	await publishHome(env, teamId, userId);
	return null;
});
