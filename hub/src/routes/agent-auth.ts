// The agent bearer auth every /v1 agent route shares: `Authorization: Bearer zc_agent_...`.

import { AGENT_CREDENTIAL_PREFIX, type AgentRow, agentCredentialHash, getAgentByCredentialHash } from "../db/agents";
import { HubError } from "../errors";

/** The non-revoked agent holding the bearer credential; throws 401 auth_failed or revoked otherwise. */
export async function authenticateAgent(db: D1Database, authorization: string | undefined): Promise<AgentRow> {
	const credential = authorization?.match(/^Bearer (\S+)$/)?.[1];
	if (!credential?.startsWith(AGENT_CREDENTIAL_PREFIX)) throw new HubError("auth_failed", 401);
	const agent = await getAgentByCredentialHash(db, await agentCredentialHash(credential));
	if (!agent) throw new HubError("auth_failed", 401);
	if (agent.revoked_at !== null) throw new HubError("revoked", 401);
	return agent;
}
