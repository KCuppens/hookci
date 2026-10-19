// Single-use pair tokens: an admin issues one for an installation, an agent
// redeems it once within 15 minutes for its long-lived credential. Only the
// sha256 of a token or credential is stored.

import { randomToken, sha256Hex } from "../crypto";
import { AGENT_CREDENTIAL_PREFIX, agentCredentialHash, countActiveAgents, getAgent, insertAgent } from "../db/agents";
import { bindAllRepos } from "../db/bindings";
import { getInstallation } from "../db/installations";
import { hitIpRate } from "../db/ip-rate";
import { tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { QUOTAS } from "../quotas";
import { ulid } from "../ulid";
import { callAgentDo, rotateCredential } from "./agents";

export const PAIR_TOKEN_PREFIX = "zc_pair_";
export const PAIR_TOKEN_TTL_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
/** Redeem attempts one IP may make per hour. */
export const REDEEMS_PER_HOUR_PER_IP = 20;

export type RedeemInput = { pair_token: string; name: string; hostname: string; agent_version: string; os: string; arch: string };
export type RedeemResult = { agent_id: string; credential: string; installation_id: number; hub_ws_url: string; name: string };

interface PairTokenRow {
	token_hash: string;
	installation_id: number;
	created_by_github_id: number;
	replaces_agent_id: string | null;
	expires_at: number;
	used_at: number | null;
}

/**
 * Issues a pair token for the installation, valid for 15 minutes. With
 * replacesAgentId, redeeming it rotates that agent's credential instead of
 * pairing a new agent. Throws pair_rate_limited (429) past
 * QUOTAS.pairTokensPerHour tokens for the installation in the last hour.
 */
export async function createPairToken(
	env: Env,
	input: { installationId: number; createdByGithubId: number; replacesAgentId?: string },
): Promise<{ token: string; expiresAt: number }> {
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const t = tenantDb(env.DB, input.installationId);
	// Every token expires PAIR_TOKEN_TTL_MS after it was issued.
	const recent = await t.first<{ n: number }>(
		"SELECT count(*) AS n FROM pair_tokens WHERE installation_id = ?1 AND expires_at > ?2",
		now - HOUR_MS + PAIR_TOKEN_TTL_MS,
	);
	if ((recent?.n ?? 0) >= QUOTAS.pairTokensPerHour) throw new HubError("pair_rate_limited", 429);

	const token = randomToken(PAIR_TOKEN_PREFIX, 20);
	const expiresAt = now + PAIR_TOKEN_TTL_MS;
	await t.run(
		`INSERT INTO pair_tokens (installation_id, token_hash, created_by_github_id, replaces_agent_id, expires_at, used_at)
		VALUES (?1, ?2, ?3, ?4, ?5, NULL)`,
		await sha256Hex(token),
		input.createdByGithubId,
		input.replacesAgentId ?? null,
		expiresAt,
	);
	return { token, expiresAt };
}

function isRedeemInput(body: unknown): body is RedeemInput {
	if (typeof body !== "object" || body === null) return false;
	const fields = body as Record<string, unknown>;
	return (["pair_token", "name", "hostname", "agent_version", "os", "arch"] as const).every((k) => typeof fields[k] === "string");
}

/**
 * Redeems a pair token from ip: pairs a new agent, or rotates the credential
 * of the agent the token replaces. The credential is returned only here.
 */
export async function redeemPairToken(env: Env, input: RedeemInput, ip: string): Promise<RedeemResult> {
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const rate = await hitIpRate(env.DB, `pairredeem:${ip}`, REDEEMS_PER_HOUR_PER_IP, HOUR_MS, now);
	if (!rate.ok) throw new HubError("rate_limited", 429);
	if (!isRedeemInput(input) || input.name.trim() === "") throw new HubError("bad_request", 400);

	// Unknown, used and expired tokens all fail here with the same answer.
	const token = input.pair_token.startsWith(PAIR_TOKEN_PREFIX)
		? await env.DB.prepare(
				"UPDATE pair_tokens SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING *",
			)
				.bind(now, await sha256Hex(input.pair_token))
				.first<PairTokenRow>()
		: null;
	if (!token) throw new HubError("invalid_pair_token", 400);

	const installation = await getInstallation(env.DB, token.installation_id);
	if (!installation || installation.suspended_at !== null || installation.deleted_at !== null) {
		throw new HubError("suspended", 403);
	}
	const t = tenantDb(env.DB, token.installation_id);
	const hubWsUrl = env.HUB_ORIGIN.replace(/^http/, "ws") + "/v1/agent/connect";

	if (token.replaces_agent_id !== null) {
		const agent = await getAgent(t, token.replaces_agent_id);
		if (!agent || agent.revoked_at !== null) throw new HubError("invalid_pair_token", 400);
		const credential = await rotateCredential(env, agent.agent_id);
		await callAgentDo(env, agent.agent_id, "repair");
		return { agent_id: agent.agent_id, credential, installation_id: token.installation_id, hub_ws_url: hubWsUrl, name: agent.name };
	}

	const active = await countActiveAgents(t);
	if (active >= QUOTAS.agentsPerInstallation) throw new HubError("agent_limit", 409);
	const agentId = `agt_${ulid(now)}`;
	const credential = randomToken(AGENT_CREDENTIAL_PREFIX, 32);
	await insertAgent(t, {
		agent_id: agentId,
		name: input.name,
		hostname: input.hostname,
		os: input.os,
		arch: input.arch,
		credential_hash: await agentCredentialHash(credential),
		agent_version: input.agent_version,
		paired_by_github_id: token.created_by_github_id,
		paired_at: now,
	});
	if (active === 0) await bindAllRepos(t, agentId, "checks");
	return { agent_id: agentId, credential, installation_id: token.installation_id, hub_ws_url: hubWsUrl, name: input.name };
}
