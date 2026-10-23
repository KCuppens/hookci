import type { BudgetOverride, StoredCapacity } from "../capacity";
import { sha256Hex } from "../crypto";
import { QUOTAS } from "../quotas";
import type { TenantDb } from "./tenant";

export interface AgentRow {
	agent_id: string;
	installation_id: number;
	name: string;
	hostname: string | null;
	os: string | null;
	arch: string | null;
	credential_hash: string;
	/** The credential a re-pair issued; it replaces credential_hash when the agent first authenticates with it. */
	next_credential_hash: string | null;
	protocol_version: number | null;
	agent_version: string | null;
	/** The operating system the agent reported in hello, like "Ubuntu 22.04" or "macOS 14.5"; null until it does. */
	os_release: string | null;
	/** The CPU budget an administrator set for the agent; null lets the agent decide. */
	budget_cpus: number | null;
	/** The memory budget in bytes an administrator set for the agent; null lets the agent decide. */
	budget_memory_bytes: number | null;
	/** CPU cores of the agent's host as its hello or capacity frame reported; null until it does. */
	host_cpus: number | null;
	host_memory_bytes: number | null;
	/** The agent's latest capacity frame as JSON (see parseStoredCapacity); null until it reports one. */
	last_capacity: string | null;
	last_capacity_at: number | null;
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

export const AGENT_CREDENTIAL_PREFIX = "hci_agent_";

/** The credential_hash of an agent credential: sha256 hex of the whole `hci_agent_` string. */
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

/** Stores a re-pair's credential hash on a non-revoked agent beside its current one; false when there is no such agent. */
export async function setNextCredentialHash(t: TenantDb, agentId: string, hash: string): Promise<boolean> {
	const res = await t.run(
		"UPDATE agents SET next_credential_hash = ?3 WHERE installation_id = ?1 AND agent_id = ?2 AND revoked_at IS NULL",
		agentId,
		hash,
	);
	return res.meta.changes > 0;
}

/** The non-revoked agent whose re-pair issued the credential with hash, across all installations. */
export async function getAgentByNextCredentialHash(db: D1Database, hash: string): Promise<AgentRow | null> {
	return db.prepare("SELECT * FROM agents WHERE next_credential_hash = ?1 AND revoked_at IS NULL").bind(hash).first<AgentRow>();
}

/**
 * Makes the re-pair credential with hash the agent's only one, so the old
 * credential stops working; null when no non-revoked agent holds it next.
 */
export async function promoteNextCredential(db: D1Database, hash: string): Promise<AgentRow | null> {
	return db
		.prepare("UPDATE agents SET credential_hash = next_credential_hash, next_credential_hash = NULL WHERE next_credential_hash = ?1 AND revoked_at IS NULL RETURNING *")
		.bind(hash)
		.first<AgentRow>();
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

/** Stores the budget override and returns false when the agent is not a non-revoked agent of this installation. */
export async function setAgentBudget(t: TenantDb, agentId: string, budget: BudgetOverride): Promise<boolean> {
	const res = await t.run(
		"UPDATE agents SET budget_cpus = ?3, budget_memory_bytes = ?4 WHERE installation_id = ?1 AND agent_id = ?2 AND revoked_at IS NULL",
		agentId,
		budget.cpus,
		budget.memory_bytes,
	);
	return res.meta.changes > 0;
}

/** Stores the agent's latest capacity report and the host size in it. */
export async function recordCapacity(t: TenantDb, agentId: string, capacity: StoredCapacity, at: number): Promise<void> {
	await t.run(
		`UPDATE agents SET host_cpus = ?3, host_memory_bytes = ?4, last_capacity = ?5, last_capacity_at = ?6
		WHERE installation_id = ?1 AND agent_id = ?2 AND revoked_at IS NULL`,
		agentId,
		capacity.host_cpus,
		capacity.host_memory_bytes,
		JSON.stringify(capacity),
		at,
	);
}

/**
 * The agent's operating system as a short printable string, or null when value is not a string or
 * nothing printable is left. Control, format and separator characters go, runs of white space
 * collapse, and the result is cut to QUOTAS.osReleaseChars characters.
 */
export function sanitizeOsRelease(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const printable = value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").replace(/\s+/g, " ").trim();
	const cut = Array.from(printable).slice(0, QUOTAS.osReleaseChars).join("").trim();
	return cut === "" ? null : cut;
}

/**
 * Records a hello or keepalive from a non-revoked agent and marks it online. osRelease, when the
 * agent has reported one (already sanitized), replaces the stored value; without it the stored
 * value stays, so an agent that predates the field keeps whatever it had.
 */
export async function touchAgent(
	t: TenantDb,
	agentId: string,
	seen: { protocolVersion: number; agentVersion: string; lastSeenAt: number; osRelease?: string | null },
): Promise<void> {
	await t.run(
		`UPDATE agents SET protocol_version = ?3, agent_version = ?4, last_seen_at = ?5, os_release = COALESCE(?6, os_release), status = 'online'
		WHERE installation_id = ?1 AND agent_id = ?2 AND revoked_at IS NULL`,
		agentId,
		seen.protocolVersion,
		seen.agentVersion,
		seen.lastSeenAt,
		seen.osRelease ?? null,
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

/**
 * The agent that runs checks for repos added to the installation: the most
 * recently paired non-revoked agent the sender paired, else the most recently
 * paired non-revoked agent of the installation, else null.
 */
export async function pickAgentForNewRepos(t: TenantDb, senderGithubId: number): Promise<string | null> {
	const row = await t.first<{ agent_id: string }>(
		`SELECT agent_id FROM agents WHERE installation_id = ?1 AND revoked_at IS NULL
		ORDER BY paired_by_github_id = ?2 DESC, paired_at DESC, agent_id DESC LIMIT 1`,
		senderGithubId,
	);
	return row?.agent_id ?? null;
}
