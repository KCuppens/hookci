// CSRF defence for the account forms, in two layers:
// - Origin: a POST whose Origin is not the hub's own is refused; with no Origin
//   header, a Sec-Fetch-Site of cross-site is refused. Browsers send
//   "Origin: null" for form posts from our Referrer-Policy: no-referrer pages,
//   so a null Origin passes only with Sec-Fetch-Site: same-origin.
// - Token: a double-submit pair. The browser holds a random value in the
//   __Host-hookci_csrf cookie; the form carries HMAC(STATE_SIGNING_KEY,
//   "csrf." + cookie). A page on another site can neither read the cookie nor
//   compute the token, and a token for one browser fails in another.

import { base64url, hmacSha256, timingSafeEqual } from "../crypto";
import type { Env } from "../env";
import { readCookie, setCookie } from "../oauth/state";

export const CSRF_COOKIE = "__Host-hookci_csrf";
const CSRF_TTL_S = 3600;
const COOKIE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** A form is a handful of short fields; a larger body is not one of ours. */
export const FORM_MAX_BYTES = 4096;

async function tokenFor(env: Env, cookieValue: string): Promise<string> {
	return base64url(await hmacSha256(env.STATE_SIGNING_KEY, `csrf.${cookieValue}`));
}

/** The token to embed in a form, and the Set-Cookie value to send when the browser has no valid csrf cookie yet. */
export async function csrfForForm(env: Env, cookieHeader: string | null): Promise<{ token: string; cookie: string | null }> {
	const existing = readCookie(cookieHeader, CSRF_COOKIE);
	if (existing !== null && COOKIE_SHAPE.test(existing)) return { token: await tokenFor(env, existing), cookie: null };
	const fresh = base64url(crypto.getRandomValues(new Uint8Array(32)));
	return { token: await tokenFor(env, fresh), cookie: setCookie(CSRF_COOKIE, fresh, CSRF_TTL_S) };
}

/** True when the request comes from the hub's own origin: Origin matches; or Origin is null and the browser says same-origin; or it is absent and the browser did not say cross-site. */
export function sameOrigin(env: Env, request: Request): boolean {
	const origin = request.headers.get("origin");
	const site = request.headers.get("sec-fetch-site");
	if (origin === "null") return site === "same-origin";
	if (origin !== null) return origin === new URL(env.HUB_ORIGIN).origin;
	return site !== "cross-site";
}

/** True when the submitted token is the one the browser's csrf cookie calls for. */
export async function validCsrfToken(env: Env, cookieHeader: string | null, submitted: string | undefined): Promise<boolean> {
	const cookie = readCookie(cookieHeader, CSRF_COOKIE);
	if (cookie === null || !COOKIE_SHAPE.test(cookie) || !submitted) return false;
	return timingSafeEqual(submitted, await tokenFor(env, cookie));
}

/**
 * The fields of a urlencoded form POST that passed both checks, or null:
 * wrong content type, no or oversized body, foreign origin, or a bad token.
 */
export async function readCheckedForm(env: Env, request: Request): Promise<Record<string, string> | null> {
	if (!sameOrigin(env, request)) return null;
	if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
	const length = Number(request.headers.get("content-length"));
	if (!Number.isInteger(length) || length < 0 || length > FORM_MAX_BYTES) return null;
	const text = await request.text();
	if (text.length > FORM_MAX_BYTES) return null;
	const fields: Record<string, string> = {};
	for (const [name, value] of new URLSearchParams(text)) fields[name] ??= value;
	return (await validCsrfToken(env, request.headers.get("cookie"), fields.csrf)) ? fields : null;
}
