// Password storage: PBKDF2-SHA256 through WebCrypto, a random 16-byte salt per
// user, and a versioned string so the cost can be raised later without a
// migration. Workers cap PBKDF2 at 100000 iterations; verifying a stored hash
// uses the iteration count written in it, and needsRehash tells a sign-in to
// store the hash again once PASSWORD_ITERATIONS moves.
//
//   pbkdf2-sha256$v1$<iterations>$<salt base64url>$<hash base64url>

import { base64url, timingSafeEqual } from "../crypto";

export const PASSWORD_ITERATIONS = 100_000;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

const SALT_BYTES = 16;
const HASH_BYTES = 32;
const SCHEME = "pbkdf2-sha256";
const VERSION = "v1";

// A real hash of a password nobody knows, spent on unknown addresses so a
// sign-in costs the same whether or not the account exists.
const DUMMY_HASH = `${SCHEME}$${VERSION}$${PASSWORD_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

export type PasswordProblem = "too_short" | "too_long" | "needs_number_or_symbol";

/** Why the password is not acceptable, or null: 8 to 256 characters with at least one number or symbol. */
export function passwordProblem(password: string): PasswordProblem | null {
	const length = [...password].length;
	if (length < PASSWORD_MIN_LENGTH) return "too_short";
	if (length > PASSWORD_MAX_LENGTH) return "too_long";
	return /[\p{N}\p{P}\p{S}]/u.test(password) ? null : "needs_number_or_symbol";
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BYTES * 8);
	return new Uint8Array(bits);
}

function fromBase64url(text: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
	try {
		const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
		return Uint8Array.from(binary, (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

/** A new hash string for the password, under a fresh random salt. */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await derive(password, salt, PASSWORD_ITERATIONS);
	return `${SCHEME}$${VERSION}$${PASSWORD_ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

/** Whether the password matches the stored string; false for any malformed or unsupported string. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, version, iterations, salt, hash, ...rest] = stored.split("$");
	if (scheme !== SCHEME || version !== VERSION || rest.length > 0 || !/^\d{1,7}$/.test(iterations ?? "")) return false;
	const cost = Number(iterations);
	const saltBytes = fromBase64url(salt ?? "");
	if (cost < 1 || cost > PASSWORD_ITERATIONS || !saltBytes || !hash) return false;
	const derived = base64url(await derive(password, saltBytes, cost));
	return timingSafeEqual(derived, hash);
}

/** Spends the work of a verification against a hash nobody can match; always false. */
export async function verifyAgainstDummy(password: string): Promise<false> {
	await verifyPassword(password, DUMMY_HASH);
	return false;
}

/** True when the stored string was made with a cost other than the current one. */
export function needsRehash(stored: string): boolean {
	return stored.split("$")[2] !== String(PASSWORD_ITERATIONS) || !stored.startsWith(`${SCHEME}$${VERSION}$`);
}
