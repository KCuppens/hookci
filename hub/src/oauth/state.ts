// Browser-flow proofs shared by the GitHub install (M1-11), GitHub user link
// (M1-14), Slack install (M1-12) and log sign-in (M3-09) flows:
// - OAuth state: signed, single use, 10 minutes, bound to the browser through
//   the __Host-hookci_oauth cookie.
// - Session: the __Host-hookci_session cookie set when a browser completed the
//   GitHub flow, naming the installations GitHub said that user can access.
//   The log sign-in keeps its own session; see auth/session.ts.

import { base64url, hmacSha256, sha256Hex, timingSafeEqual } from "../crypto";
import type { Env } from "../env";
import { HubError } from "../errors";

export type OAuthKind = "github_install" | "github_link" | "slack_install" | "github_logs" | "dashboard_login" | "google_login";
/** cookie is the full Set-Cookie header value. */
export interface IssuedState {
	state: string;
	cookie: string;
}

export const STATE_TTL_MS = 600_000;
export const STATE_COOKIE = "__Host-hookci_oauth";
/** A session ends after this long without a request... */
export const SESSION_IDLE_MS = 12 * 3600_000;
/** ...and never outlives this, however active: GitHub access is only re-checked at sign-in. */
export const SESSION_MAX_MS = 7 * 24 * 3600_000;
/** An active session's cookie is re-issued once this much of its idle window has passed. */
const SESSION_RENEW_AFTER_MS = 5 * 60_000;
export const SESSION_COOKIE = "__Host-hookci_session";

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
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

/** The payload of a stored state; throws oauth_state_invalid when it is not a JSON object. */
function parsePayload(raw: string | null | undefined): Record<string, unknown> {
	const payload: unknown = raw ? JSON.parse(raw) : null;
	if (!isPayload(payload)) throw new HubError("oauth_state_invalid", 400);
	return payload;
}

/** The nonce of state when its signature holds for kind, else null. */
async function verifiedNonce(env: Env, kind: OAuthKind, state: string): Promise<string | null> {
	const [nonce, signature, ...rest] = state.split(".");
	if (!nonce || !signature || rest.length > 0) return null;
	return timingSafeEqual(signature, await sign(env, `${kind}.${nonce}`)) ? nonce : null;
}

/** The nonce of state when its signature holds for kind; throws oauth_state_invalid otherwise. */
async function signedNonce(env: Env, kind: OAuthKind, state: string): Promise<string> {
	const nonce = await verifiedNonce(env, kind, state);
	if (nonce === null) throw new HubError("oauth_state_invalid", 400);
	return nonce;
}

/** The known, unused, unexpired state row of kind for nonce; throws oauth_state_invalid otherwise. */
async function liveState(env: Env, kind: OAuthKind, nonce: string, now: number): Promise<{ expires_at: number; payload: string | null }> {
	const row = await env.DB.prepare(
		"SELECT expires_at, payload FROM oauth_states WHERE nonce_hash = ?1 AND kind = ?2 AND used_at IS NULL AND expires_at > ?3",
	)
		.bind(await sha256Hex(nonce), kind, now)
		.first<{ expires_at: number; payload: string | null }>();
	if (!row) throw new HubError("oauth_state_invalid", 400);
	return row;
}

/**
 * For a state issued outside the browser, as in a Slack link: checks without
 * using it that state is a known, unused, unexpired state of kind, and returns
 * its payload with a Set-Cookie value marking that this browser was shown the
 * confirmation page. The mark is an HMAC of the nonce, not the nonce, so it
 * cannot finish OAuth; confirmState trades it for the nonce. Throws
 * oauth_state_invalid (400).
 */
export async function previewState(
	env: Env,
	kind: OAuthKind,
	state: string,
	now: number,
): Promise<{ payload: Record<string, unknown>; cookie: string }> {
	const nonce = await signedNonce(env, kind, state);
	const row = await liveState(env, kind, nonce, now);
	const maxAge = Math.ceil((row.expires_at - now) / 1000);
	return { payload: parsePayload(row.payload), cookie: setCookie(STATE_COOKIE, await sign(env, `preview.${kind}.${nonce}`), maxAge) };
}

/**
 * For the confirmation page's POST: requires the mark previewState set for
 * this state, and returns the Set-Cookie value binding this browser to the
 * state until it expires. A cross-site POST carries no SameSite=Lax cookie, so
 * only a POST from the page passes. Throws oauth_state_invalid (400) otherwise.
 */
export async function confirmState(env: Env, kind: OAuthKind, state: string, cookieHeader: string | null, now: number): Promise<string> {
	const nonce = await signedNonce(env, kind, state);
	if (!timingSafeEqual(readCookie(cookieHeader, STATE_COOKIE) ?? "", await sign(env, `preview.${kind}.${nonce}`))) {
		throw new HubError("oauth_state_invalid", 400);
	}
	const row = await liveState(env, kind, nonce, now);
	return setCookie(STATE_COOKIE, nonce, Math.ceil((row.expires_at - now) / 1000));
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
	const nonce = await signedNonce(env, kind, state);
	if (!timingSafeEqual(readCookie(cookieHeader, STATE_COOKIE) ?? "", nonce)) throw new HubError("oauth_state_invalid", 400);
	const row = await env.DB.prepare(
		`UPDATE oauth_states SET used_at = ?3
		WHERE nonce_hash = ?1 AND kind = ?2 AND used_at IS NULL AND expires_at > ?3 RETURNING payload`,
	)
		.bind(await sha256Hex(nonce), kind, now)
		.first<{ payload: string | null }>();
	return parsePayload(row?.payload);
}

/**
 * consumeState for a callback shared by several kinds: consumes state as the
 * first of kinds whose signature it carries, and returns that kind with the
 * payload. Throws oauth_state_invalid (400) when it carries none of them.
 */
export async function consumeAnyState<K extends OAuthKind>(
	env: Env,
	kinds: readonly K[],
	state: string,
	cookieHeader: string | null,
	now: number,
): Promise<{ kind: K; payload: Record<string, unknown> }> {
	for (const kind of kinds) {
		if ((await verifiedNonce(env, kind, state)) !== null) return { kind, payload: await consumeState(env, kind, state, cookieHeader, now) };
	}
	throw new HubError("oauth_state_invalid", 400);
}

/** Set-Cookie value that removes the state cookie once its state is consumed. */
export const CLEAR_STATE_COOKIE = setCookie(STATE_COOKIE, "", 0);

export interface Session {
	/** Installations GitHub reported this user can access; empty for an account that has not linked GitHub. */
	installationIds: number[];
	/** 0 for an account that has not linked GitHub. */
	githubUserId: number;
	/** GitHub logins hold only letters, digits and hyphens, so they never contain the "." separator. "-" for an account that has not linked GitHub. */
	githubLogin: string;
	/** The email account (a ULID) the browser signed in with, when ACCOUNTS_ENABLED; absent for a plain GitHub sign-in. */
	accountId?: string;
}

// An empty installation list is written as "0"; ids are positive integers.
const IDS_SHAPE = /^(?:0|[1-9]\d*(?:-[1-9]\d*)*)$/;
const ACCOUNT_ID_SHAPE = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** When a session touched at now ends: the idle window, cut off at the absolute cap after startedAt. */
function sessionExpiry(now: number, startedAt: number): number {
	return Math.min(now + SESSION_IDLE_MS, startedAt + SESSION_MAX_MS);
}

/**
 * Set-Cookie value for a session. It lasts SESSION_IDLE_MS from now, capped at
 * SESSION_MAX_MS after startedAt (the sign-in time, which defaults to now). The value is
 * "<id>-<id>.<github user id>.<github login>.<expires at ms>.<started at ms>[.<account id>].<hmac>".
 */
export async function issueSession(env: Env, session: Session, now: number, startedAt: number = now): Promise<string> {
	const ids = session.installationIds.length > 0 ? session.installationIds.join("-") : "0";
	const account = session.accountId === undefined ? "" : `.${session.accountId}`;
	const expires = sessionExpiry(now, startedAt);
	const body = `${ids}.${session.githubUserId}.${session.githubLogin}.${expires}.${startedAt}${account}`;
	return setCookie(SESSION_COOKIE, `${body}.${await sign(env, `session.${body}`)}`, Math.max(0, Math.ceil((expires - now) / 1000)));
}

interface ParsedSession {
	session: Session;
	expires: number;
	startedAt: number;
}

async function parseSession(env: Env, cookieHeader: string | null | undefined, now: number): Promise<ParsedSession | null> {
	const value = readCookie(cookieHeader, SESSION_COOKIE);
	if (!value) return null;
	const parts = value.split(".");
	const signature = parts.pop();
	if (!signature || (parts.length !== 5 && parts.length !== 6)) return null;
	const [ids = "", user = "", login = "", expires = "", started = "", accountId] = parts;
	if (!IDS_SHAPE.test(ids) || !/^\d+$/.test(user) || !/^[A-Za-z0-9-]+$/.test(login) || !/^\d+$/.test(expires) || !/^\d+$/.test(started)) return null;
	if (accountId !== undefined && !ACCOUNT_ID_SHAPE.test(accountId)) return null;
	if (!timingSafeEqual(signature, await sign(env, `session.${parts.join(".")}`))) return null;
	if (Number(expires) <= now) return null;
	return {
		session: {
			installationIds: ids === "0" ? [] : ids.split("-").map(Number),
			githubUserId: Number(user),
			githubLogin: login,
			...(accountId === undefined ? {} : { accountId }),
		},
		expires: Number(expires),
		startedAt: Number(started),
	};
}

/** The session from the Cookie header when its signature holds, its fields are well formed and it is unexpired; else null. */
export async function readAnySession(env: Env, cookieHeader: string | null | undefined, now: number): Promise<Session | null> {
	return (await parseSession(env, cookieHeader, now))?.session ?? null;
}

/**
 * A fresh Set-Cookie for the valid session in the Cookie header, with the idle window restarted and
 * the sign-in time kept; null when there is no valid session or its expiry would not move by
 * at least SESSION_RENEW_AFTER_MS (an idle window already near full, or the absolute cap reached).
 */
export async function renewSession(env: Env, cookieHeader: string | null | undefined, now: number): Promise<string | null> {
	const parsed = await parseSession(env, cookieHeader, now);
	if (!parsed) return null;
	const next = sessionExpiry(now, parsed.startedAt);
	if (next - parsed.expires < SESSION_RENEW_AFTER_MS) return null;
	return issueSession(env, parsed.session, now, parsed.startedAt);
}

/** The session from the Cookie header when its signature holds, it is unexpired and it covers installationId; else null. */
export async function readSession(
	env: Env,
	cookieHeader: string | null | undefined,
	installationId: number,
	now: number,
): Promise<Session | null> {
	const session = await readAnySession(env, cookieHeader, now);
	return session?.installationIds.includes(installationId) ? session : null;
}
