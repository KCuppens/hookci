import { sha256Hex } from "../crypto";
import type { TenantDb } from "./tenant";

export interface AgentRow {
	agent_id: string;
	installation_id: number;
	name: string;
	hostname: string | null;
	os: string | null;
	arch: string | null;
	credential_hash: string;
	protocol_version: number | null;
	agent_version: string | null;
	last_seen_at: number | null;
	revoked_at: number | null;
	paired_by_github_id: number;
	paired_at: number;
	status: "online" | "offline" | "revoked";
}

export type NewAgent = Pick<
	AgentRow,
	"agent_id" | "name" | "hostname" | "os" | "arch" | "credential_hash" | "agent_version" | "paired_by_github_id" | "paired_at"
>;

export const AGENT_CREDENTIAL_PREFIX = "zc_agent_";

/** The credential_hash of an agent credential: sha256 hex of the whole `zc_agent_` string. */
export function agentCredentialHash(credential: string): Promise<string> {
	return sha256Hex(credential);
}

/** Inserts a freshly paired agent; it starts offline. */
export async function insertAgent(t: TenantDb, row: NewAgent): Promise<void> {
	await t.run(
		`INSERT INTO agents (installation_id, agent_id, name, hostname, os, arch, credential_hash, agent_version, paired_by_github_id, paired_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
		row.agent_id,
		row.name,
		row.hostname,
		row.os,
		row.arch,
		row.credential_hash,
		row.agent_version,
		row.paired_by_github_id,
		row.paired_at,
	);
}

/**
 * Finds the agent holding a credential, across all installations. Only the
 * agent hello auth uses it; the row's installation_id scopes everything after.
 */
export async function getAgentByCredentialHash(db: D1Database, hash: string): Promise<AgentRow | null> {
	return db.prepare("SELECT * FROM agents WHERE credential_hash = ?1").bind(hash).first<AgentRow>();
}

/** Finds an agent by id across all installations; the row's installation_id scopes everything after. */
export async function getAgentById(db: D1Database, agentId: string): Promise<AgentRow | null> {
	return db.prepare("SELECT * FROM agents WHERE agent_id = ?1").bind(agentId).first<AgentRow>();
}

/** Replaces a non-revoked agent's credential hash; false when there is no such agent. */
export async function setCredentialHash(t: TenantDb, agentId: string, hash: string): Promise<boolean> {
	const res = await t.run(
		"UPDATE agents SET credential_hash = ?3 WHERE installation_id = ?1 AND agent_id = ?2 AND revoked_at IS NULL",
		agentId,
		hash,
	);
	return res.meta.changes > 0;
}

export async function listAgents(t: TenantDb): Promise<AgentRow[]> {
	return t.all<AgentRow>("SELECT * FROM agents WHERE installation_id = ?1 ORDER BY paired_at, agent_id");
}

export async function getAgent(t: TenantDb, agentId: string): Promise<AgentRow | null> {
	return t.first<AgentRow>("SELECT * FROM agents WHERE installation_id = ?1 AND agent_id = ?2", agentId);
}

/** Marks the agent revoked; false when it is not an agent of this installation. */
export async function revokeAgent(t: TenantDb, agentId: string, at: number): Promise<boolean> {
	const res = await t.run(
		"UPDATE agents SET revoked_at = coalesce(revoked_at, ?3), status = 'revoked' WHERE installation_id = ?1 AND agent_id = ?2",
		agentId,
		at,
	);
	return res.meta.changes > 0;
}

/** Records a hello or keepalive from a non-revoked agent and marks it online. */
export async function touchAgent(
	t: TenantDb,
	agentId: string,
	seen: { protocolVersion: number; agentVersion: string; lastSeenAt: number },
): Promise<void> {
	await t.run(
		`UPDATE agents SET protocol_version = ?3, agent_version = ?4, last_seen_at = ?5, status = 'online'
		WHERE installation_id = ?1 AND agent_id = ?2 AND revoked_at IS NULL`,
		agentId,
		seen.protocolVersion,
		seen.agentVersion,
		seen.lastSeenAt,
	);
}

/** Marks a non-revoked agent offline, last seen at lastSeenAt. */
export async function markAgentOffline(t: TenantDb, agentId: string, lastSeenAt: number): Promise<void> {
	await t.run(
		"UPDATE agents SET status = 'offline', last_seen_at = ?3 WHERE installation_id = ?1 AND agent_id = ?2 AND revoked_at IS NULL",
		agentId,
		lastSeenAt,
	);
}

/** Agents that are not revoked, the count the agentsPerInstallation quota limits. */
export async function countActiveAgents(t: TenantDb): Promise<number> {
	const row = await t.first<{ n: number }>("SELECT count(*) AS n FROM agents WHERE installation_id = ?1 AND revoked_at IS NULL");
	return row?.n ?? 0;
}
