// Browser-flow proofs shared by the GitHub install (M1-11), GitHub user link
// (M1-14) and Slack install (M1-12) flows:
// - OAuth state: signed, single use, 10 minutes, bound to the browser through
//   the __Host-zeroci_oauth cookie.
// - Session: the __Host-zeroci_session cookie set when a browser completed the
//   GitHub flow, naming the installations GitHub said that user can access.

import { base64url, hmacSha256, sha256Hex, timingSafeEqual } from "../crypto";
import type { Env } from "../env";
import { HubError } from "../errors";

export type OAuthKind = "github_install" | "github_link" | "slack_install";
/** cookie is the full Set-Cookie header value. */
export interface IssuedState {
	state: string;
	cookie: string;
}

export const STATE_TTL_MS = 600_000;
export const STATE_COOKIE = "__Host-zeroci_oauth";
export const SESSION_TTL_MS = 30 * 60_000;
export const SESSION_COOKIE = "__Host-zeroci_session";

function setCookie(name: string, value: string, maxAgeSeconds: number): string {
	return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** The value of cookie name in a Cookie request header, or null. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}

async function sign(env: Env, data: string): Promise<string> {
	return base64url(await hmacSha256(env.STATE_SIGNING_KEY, data));
}

/** Records a fresh state of kind carrying payload; the caller sends `cookie` and puts `state` in the provider URL. */
export async function issueState(env: Env, kind: OAuthKind, payload: Record<string, unknown>, now: number): Promise<IssuedState> {
	const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
	await env.DB.prepare("INSERT INTO oauth_states (nonce_hash, kind, payload, expires_at, used_at) VALUES (?1, ?2, ?3, ?4, NULL)")
		.bind(await sha256Hex(nonce), kind, JSON.stringify(payload), now + STATE_TTL_MS)
		.run();
	return { state: `${nonce}.${await sign(env, `${kind}.${nonce}`)}`, cookie: setCookie(STATE_COOKIE, nonce, STATE_TTL_MS / 1000) };
}

function isPayload(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Marks the state used and returns its payload. Throws oauth_state_invalid
 * (400) on a bad signature, another kind, a cookie that does not hold the
 * state's nonce, or a state that is unknown, used or older than 10 minutes.
 */
export async function consumeState(
	env: Env,
	kind: OAuthKind,
	state: string,
	cookieHeader: string | null,
	now: number,
): Promise<Record<string, unknown>> {
	const invalid = new HubError("oauth_state_invalid", 400);
	const [nonce, signature, ...rest] = state.split(".");
	if (!nonce || !signature || rest.length > 0) throw invalid;
	if (!timingSafeEqual(signature, await sign(env, `${kind}.${nonce}`))) throw invalid;
	if (!timingSafeEqual(readCookie(cookieHeader, STATE_COOKIE) ?? "", nonce)) throw invalid;
	const row = await env.DB.prepare(
		`UPDATE oauth_states SET used_at = ?3
		WHERE nonce_hash = ?1 AND kind = ?2 AND used_at IS NULL AND expires_at > ?3 RETURNING payload`,
	)
		.bind(await sha256Hex(nonce), kind, now)
		.first<{ payload: string | null }>();
	if (!row?.payload) throw invalid;
	const payload: unknown = JSON.parse(row.payload);
	if (!isPayload(payload)) throw invalid;
	return payload;
}

/** Set-Cookie value that removes the state cookie once its state is consumed. */
export const CLEAR_STATE_COOKIE = setCookie(STATE_COOKIE, "", 0);

export interface Session {
	/** Installations GitHub reported this user can access. */
	installationIds: number[];
	githubUserId: number;
	/** GitHub logins hold only letters, digits and hyphens, so they never contain the "." separator. */
	githubLogin: string;
}

/**
 * Set-Cookie value for a session valid for 30 minutes from now. The value is
 * "<id>-<id>.<github user id>.<github login>.<expires at ms>.<hmac>".
 */
export async function issueSession(env: Env, session: Session, now: number): Promise<string> {
	const body = `${session.installationIds.join("-")}.${session.githubUserId}.${session.githubLogin}.${now + SESSION_TTL_MS}`;
	return setCookie(SESSION_COOKIE, `${body}.${await sign(env, `session.${body}`)}`, SESSION_TTL_MS / 1000);
}

/** The session from the Cookie header when its signature holds, it is unexpired and it covers installationId; else null. */
export async function readSession(
	env: Env,
	cookieHeader: string | null | undefined,
	installationId: number,
	now: number,
): Promise<Session | null> {
	const value = readCookie(cookieHeader, SESSION_COOKIE);
	if (!value) return null;
	const [ids, user, login, expires, signature, ...rest] = value.split(".");
	if (!ids || !user || !login || !expires || !signature || rest.length > 0) return null;
	const body = `${ids}.${user}.${login}.${expires}`;
	if (!timingSafeEqual(signature, await sign(env, `session.${body}`))) return null;
	if (Number(expires) <= now) return null;
	const installationIds = ids.split("-").map(Number);
	if (!installationIds.includes(installationId)) return null;
	return { installationIds, githubUserId: Number(user), githubLogin: login };
}
