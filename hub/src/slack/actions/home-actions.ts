// App Home buttons. Add agent and Revoke carry the installation id as value
// and re-check, uncached, that the caller administers that installation.

import { getAgent } from "../../db/agents";
import { getInstallation, type InstallationRow } from "../../db/installations";
import { tenantDb } from "../../db/tenant";
import { listLinkedInstallationIds } from "../../db/workspaces";
import type { Env } from "../../env";
import { HubError } from "../../errors";
import { getLinkedUser, type LinkedUser } from "../../identity/link";
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
	if (!installation || !(await isInstallationAdmin(env, commandGitHub(env), installation, user.githubLogin, true))) {
		return ephemeral(S.slack.forbidden);
	}
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
	await slackApi(env, teamId, "views.open", { trigger_id: triggerId, view: pairTokenModal(pair.token, `${env.HUB_ORIGIN}/install`, pair.expiresAt) });
	return null;
});

registerAction("home:revoke_agent", async ({ env, teamId, userId, actionId, value }) => {
	const user = await getLinkedUser(env, teamId, userId);
	if (!user) return ephemeral(S.slack.notLinked);
	const installation = await adminInstallation(env, teamId, user, value);
	if (!("id" in installation)) return installation;
	const agent = await getAgent(tenantDb(env.DB, installation.id), actionId.slice("home:revoke_agent:".length));
	if (!agent) return ephemeral(S.slack.forbidden);
	await revokeAgent(env, agent.agent_id, "revoked");
	await publishHome(env, teamId, userId);
	return null;
});

registerAction("home:refresh", async ({ env, teamId, userId }) => {
	await publishHome(env, teamId, userId);
	return null;
});
