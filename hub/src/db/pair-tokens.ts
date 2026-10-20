// pair_tokens access that cannot be installation-scoped: a token is redeemed
// before the hub knows which installation it belongs to.

export interface PairTokenRow {
	token_hash: string;
	installation_id: number;
	created_by_github_id: number;
	replaces_agent_id: string | null;
	expires_at: number;
	used_at: number | null;
}

/** The unused, unexpired token with tokenHash, or null; reading it does not consume it. */
export async function findPairToken(db: D1Database, tokenHash: string, now: number): Promise<PairTokenRow | null> {
	return db
		.prepare("SELECT * FROM pair_tokens WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2")
		.bind(tokenHash, now)
		.first<PairTokenRow>();
}

/**
 * Marks the unused, unexpired token with tokenHash used at now and returns it,
 * or null when no such token exists. A token is consumed at most once.
 */
export async function consumePairToken(db: D1Database, tokenHash: string, now: number): Promise<PairTokenRow | null> {
	return db
		.prepare("UPDATE pair_tokens SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING *")
		.bind(now, tokenHash)
		.first<PairTokenRow>();
}
