// Emailed links: 32 random bytes, shown once in the link, stored only as their
// SHA-256, single use. A newer token of the same kind retires older ones, and
// using one retires the rest.

import { base64url, sha256Hex } from "../crypto";
import { consumeEmailToken, type EmailTokenKind, peekEmailToken, replaceEmailToken } from "../db/accounts";

const HOUR_MS = 60 * 60_000;

export const TOKEN_TTL_MS: Record<EmailTokenKind, number> = { verify: 24 * HOUR_MS, reset: HOUR_MS };

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Mints a token for the user and returns the raw value to put in the email; only its hash is stored. */
export async function issueEmailToken(db: D1Database, userId: string, kind: EmailTokenKind, now: number): Promise<string> {
	const raw = base64url(crypto.getRandomValues(new Uint8Array(32)));
	await replaceEmailToken(db, userId, kind, await sha256Hex(raw), now, TOKEN_TTL_MS[kind]);
	return raw;
}

/** The user the token names while it is live, without using it; null for anything else, including a malformed value. */
export async function peekToken(db: D1Database, raw: string, kind: EmailTokenKind, now: number): Promise<string | null> {
	if (!TOKEN_SHAPE.test(raw)) return null;
	return peekEmailToken(db, await sha256Hex(raw), kind, now);
}

/** Uses the token and returns its user; null when it is malformed, unknown, expired or already used. */
export async function consumeToken(db: D1Database, raw: string, kind: EmailTokenKind, now: number): Promise<string | null> {
	if (!TOKEN_SHAPE.test(raw)) return null;
	return consumeEmailToken(db, await sha256Hex(raw), kind, now);
}
