// API tokens: installation-scoped bearer credentials for programmatic
// clients (the MCP server). Modelled on agents.ts's credential hashing, but
// a token has no agent behind it and no re-pair, so it is simpler: one hash,
// revoked by setting revoked_at.

import { randomToken, sha256Hex } from "../crypto";
import { ulid } from "../ulid";
import type { TenantDb } from "./tenant";

export interface ApiTokenRow {
	installation_id: number;
	token_id: string;
	token_hash: string;
	name: string;
	created_at: number;
	created_by_github_id: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

export const API_TOKEN_PREFIX = "hci_mcp_";

/** The token_hash of a presented token: sha256 hex of the whole `hci_mcp_` string. */
export function apiTokenHash(token: string): Promise<string> {
	return sha256Hex(token);
}

/** A fresh token id (for the row's primary key, independent of the bearer secret) and bearer credential. */
export function generateApiToken(now: number): { tokenId: string; token: string } {
	return { tokenId: `tok_${ulid(now)}`, token: randomToken(API_TOKEN_PREFIX, 32) };
}

export type NewApiToken = Pick<ApiTokenRow, "token_id" | "token_hash" | "name" | "created_at" | "created_by_github_id">;

export async function insertApiToken(t: TenantDb, row: NewApiToken): Promise<void> {
	await t.run(
		`INSERT INTO api_tokens (installation_id, token_id, token_hash, name, created_at, created_by_github_id)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
		row.token_id,
		row.token_hash,
		row.name,
		row.created_at,
		row.created_by_github_id,
	);
}

/** The installation's tokens, newest first, including revoked ones (the settings page shows both). */
export async function listApiTokens(t: TenantDb): Promise<ApiTokenRow[]> {
	return t.all<ApiTokenRow>("SELECT * FROM api_tokens WHERE installation_id = ?1 ORDER BY created_at DESC");
}

/**
 * Finds the token holding a credential hash, across all installations. Only
 * MCP auth uses it; the row's installation_id scopes everything after.
 */
export async function getApiTokenByHash(db: D1Database, hash: string): Promise<ApiTokenRow | null> {
	return db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?1").bind(hash).first<ApiTokenRow>();
}

/** Marks a token revoked; false when there is no such non-revoked token of this installation. */
export async function revokeApiToken(t: TenantDb, tokenId: string, at: number): Promise<boolean> {
	const res = await t.run("UPDATE api_tokens SET revoked_at = ?2 WHERE installation_id = ?1 AND token_id = ?3 AND revoked_at IS NULL", at, tokenId);
	return res.meta.changes > 0;
}

/** Best-effort last-used stamp; callers should not await this on the request's critical path. */
export async function touchApiToken(db: D1Database, installationId: number, tokenId: string, at: number): Promise<void> {
	await db.prepare("UPDATE api_tokens SET last_used_at = ?3 WHERE installation_id = ?1 AND token_id = ?2").bind(installationId, tokenId, at).run();
}
