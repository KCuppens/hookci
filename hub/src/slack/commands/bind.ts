// /zeroci bind <owner/repo> <agent> [checks|deploy:<env>]: makes a paired,
// non-revoked agent of the repo's installation run the target (default
// checks) for the repo.

import { listAgents } from "../../db/agents";
import { type BindingTarget, bind } from "../../db/bindings";
import { tenantDb } from "../../db/tenant";
import { requireLinkedUser } from "../../identity/link";
import { S } from "../../strings";
import { registerCommand } from "../registry";
import { requireRepoAccess } from "../resolve";
import { commandArgs, ephemeral } from "./common";

const USAGE = "/zeroci bind <owner/repo> <agent> [checks|deploy:<env>]";

function isBindingTarget(value: string): value is BindingTarget {
	return value === "checks" || /^deploy:[a-z0-9_-]+$/i.test(value);
}

registerCommand("bind", async ({ env, teamId, userId, text }) => {
	const user = await requireLinkedUser(env, teamId, userId);
	const [fullName, agentName, target = "checks", ...rest] = commandArgs(text);
	if (!fullName || !agentName || rest.length > 0) return ephemeral(S.slack.usage(USAGE));
	if (!isBindingTarget(target)) return ephemeral(S.slack.badTarget);
	const { repo } = await requireRepoAccess(env, teamId, user, fullName, "admin");
	const t = tenantDb(env.DB, repo.installationId);
	const active = (await listAgents(t)).filter((agent) => agent.revoked_at === null);
	const byId = active.find((agent) => agent.agent_id === agentName);
	const byName = active.filter((agent) => agent.name === agentName);
	if (!byId && byName.length > 1) return ephemeral(S.slack.agentAmbiguous(agentName));
	const agent = byId ?? byName[0];
	if (!agent) return ephemeral(S.slack.agentNotFound(agentName));
	await bind(t, repo.repoId, target, agent.agent_id);
	return ephemeral(S.slack.bound(repo.fullName, target, agent.name));
});
