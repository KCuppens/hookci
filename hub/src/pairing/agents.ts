// Agent credential rotation and revocation. Both act on an agent's D1 row;
// revokeAgent also stops the agent through its AgentDO.

import { randomToken } from "../crypto";
import {
	AGENT_CREDENTIAL_PREFIX,
	agentCredentialHash,
	getAgentById,
	revokeAgent as markRevoked,
	setCredentialHash,
} from "../db/agents";
import { tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { HubError } from "../errors";
import { systemClock } from "../do/clock";

/** Calls `POST https://do/<path>` on the agent's AgentDO. */
export async function callAgentDo(env: Env, agentId: string, path: "repair" | "revoke", body: unknown = {}): Promise<void> {
	const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(agentId));
	const res = await stub.fetch(`https://do/${path}`, { method: "POST", body: JSON.stringify(body) });
	if (!res.ok) throw new HubError("agent_do_failed", 502, `AgentDO /${path} answered ${res.status}`);
}

/**
 * Gives a non-revoked agent a new credential and returns it; the old one
 * stops working in the same statement. Only the sha256 is stored.
 */
export async function rotateCredential(env: Env, agentId: string): Promise<string> {
	const agent = await getAgentById(env.DB, agentId);
	if (!agent || agent.revoked_at !== null) throw new HubError("unknown_agent", 404, `no active agent ${agentId}`);
	const credential = randomToken(AGENT_CREDENTIAL_PREFIX, 32);
	const rotated = await setCredentialHash(tenantDb(env.DB, agent.installation_id), agentId, await agentCredentialHash(credential));
	if (!rotated) throw new HubError("unknown_agent", 404, `agent ${agentId} was revoked during rotation`);
	return credential;
}

/**
 * Revokes the agent: its credential stops working, its repo bindings go (so
 * those repos route to no_agent), and its AgentDO interrupts its runs and
 * closes the socket.
 */
export async function revokeAgent(env: Env, agentId: string, reason: "revoked" | "uninstalled"): Promise<void> {
	const agent = await getAgentById(env.DB, agentId);
	if (!agent) throw new HubError("unknown_agent", 404, `no agent ${agentId}`);
	const t = tenantDb(env.DB, agent.installation_id);
	await markRevoked(t, agentId, (env.__TEST_CLOCK ?? systemClock).now());
	await t.run("DELETE FROM repo_bindings WHERE installation_id = ?1 AND agent_id = ?2", agentId);
	await callAgentDo(env, agentId, "revoke", { reason });
}
