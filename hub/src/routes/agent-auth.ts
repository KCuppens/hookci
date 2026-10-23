// The agent bearer auth every /v1 agent route shares: `Authorization: Bearer hci_agent_...`.

import {
	AGENT_CREDENTIAL_PREFIX,
	type AgentRow,
	agentCredentialHash,
	getAgentByCredentialHash,
	getAgentByNextCredentialHash,
	promoteNextCredential,
} from "../db/agents";
import type { Env } from "../env";
import { HubError } from "../errors";
import { callAgentDo } from "../pairing/agents";

/**
 * The non-revoked agent holding the bearer credential; throws 401 auth_failed
 * or revoked otherwise. The first use of a re-pair's credential repairs the
 * agent (interrupts its runs, closes the socket the old credential opened)
 * and only then makes it the agent's credential, so a failed repair leaves
 * the old credential working.
 */
export async function authenticateAgent(env: Env, authorization: string | undefined): Promise<AgentRow> {
	const credential = authorization?.match(/^Bearer (\S+)$/)?.[1];
	if (!credential?.startsWith(AGENT_CREDENTIAL_PREFIX)) throw new HubError("auth_failed", 401);
	const hash = await agentCredentialHash(credential);
	let agent = await getAgentByCredentialHash(env.DB, hash);
	if (!agent) {
		const repaired = await getAgentByNextCredentialHash(env.DB, hash);
		if (!repaired) throw new HubError("auth_failed", 401);
		await callAgentDo(env, repaired.agent_id, "repair");
		// A concurrent request with the same credential may have promoted it first.
		agent = (await promoteNextCredential(env.DB, hash)) ?? (await getAgentByCredentialHash(env.DB, hash));
		if (!agent) throw new HubError("auth_failed", 401);
	}
	if (agent.revoked_at !== null) throw new HubError("revoked", 401);
	return agent;
}
