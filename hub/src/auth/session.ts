// The log sign-in session: the zc_session cookie a browser gets once GitHub
// told the hub who it is (routes/log-links.ts). It names the GitHub user and
// holds no GitHub token; each private log link checks that user's role on the
// repo with the installation token. The value is
// "sess1.<base64url JSON payload>.<base64url HMAC-SHA256>" under a key derived
// from LOG_SIGNING_KEY.

import { base64Bytes, base64url, timingSafeEqual } from "../crypto";
import type { Env } from "../env";
import { logSigningKey } from "../logs/signing";
import { readCookie, setCookie } from "../oauth/state";

export const SESSION_COOKIE = "zc_session";
export const SESSION_TTL_SEC = 8 * 3600;

const VERSION = "sess1";
const utf8 = new TextEncoder();

export interface Session {
	githubUserId: number;
	login: string;
	/** Unix seconds after which the session is refused. */
	exp: number;
}

/** HMAC-SHA256 of the versioned payload under HKDF-SHA256(LOG_SIGNING_KEY, "zeroci-session-v1"), base64url; throws log_signing_key_missing when the key is empty. */
async function mac(env: Env, payload: string): Promise<string> {
	const base = await crypto.subtle.importKey("raw", utf8.encode(logSigningKey(env)), "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode("zeroci-session-v1") },
		base,
		256,
	);
	const key = await crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return base64url(await crypto.subtle.sign("HMAC", key, utf8.encode(`${VERSION}.${payload}`)));
}

function decodePayload(payload: string): unknown {
	const bytes = base64Bytes(payload.replaceAll("-", "+").replaceAll("_", "/"));
	if (!bytes) return null;
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

function isSession(value: unknown): value is Session {
	if (typeof value !== "object" || value === null) return false;
	const s = value as Record<string, unknown>;
	return Number.isSafeInteger(s.githubUserId) && typeof s.login === "string" && s.login !== "" && Number.isSafeInteger(s.exp);
}

/** Set-Cookie value for a session of user, valid SESSION_TTL_SEC from now (ms); throws log_signing_key_missing when LOG_SIGNING_KEY is empty. */
export async function issueSession(env: Env, user: Omit<Session, "exp">, now: number): Promise<string> {
	const session: Session = { githubUserId: user.githubUserId, login: user.login, exp: Math.floor(now / 1000) + SESSION_TTL_SEC };
	const payload = base64url(utf8.encode(JSON.stringify(session)));
	return setCookie(SESSION_COOKIE, `${VERSION}.${payload}.${await mac(env, payload)}`, SESSION_TTL_SEC);
}

/** The session in req's cookie, or null when it is missing, altered, of another version, expired at now (ms) or LOG_SIGNING_KEY is empty. */
export async function readSession(env: Env, req: Request, now: number): Promise<Session | null> {
	if (!env.LOG_SIGNING_KEY) return null;
	const value = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
	const [version, payload, signature, ...rest] = value?.split(".") ?? [];
	if (version !== VERSION || !payload || !signature || rest.length > 0) return null;
	if (!timingSafeEqual(signature, await mac(env, payload))) return null;
	const session = decodePayload(payload);
	if (!isSession(session) || session.exp * 1000 <= now) return null;
	return { githubUserId: session.githubUserId, login: session.login, exp: session.exp };
}
