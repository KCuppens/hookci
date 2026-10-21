// "Continue with Google": OAuth 2.0 authorization code with PKCE (S256). The
// state is bound to the browser by the same cookie as the GitHub flows, and the
// PKCE verifier waits in the state's stored payload, so the code is useless to
// anyone who intercepts it. The identity comes from Google's userinfo endpoint,
// called with the access token this hub just received from Google's token
// endpoint; the caller still decides whether to trust `email_verified`.

import { base64url } from "../crypto";
import type { Env } from "../env";
import { HubError } from "../errors";
import type { Fetcher } from "../http";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const GOOGLE_CALLBACK_PATH = "/account/google/callback";

export interface GoogleIdentity {
	sub: string;
	email: string;
	emailVerified: boolean;
}

/** True when both client secrets are set; the Google button is hidden otherwise. */
export function googleConfigured(env: Env): boolean {
	return Boolean(env.GOOGLE_CLIENT_ID) && Boolean(env.GOOGLE_CLIENT_SECRET);
}

/** A fresh PKCE code verifier: 32 random bytes, base64url, 43 characters. */
export function newCodeVerifier(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The S256 code challenge for a verifier. */
export async function codeChallenge(verifier: string): Promise<string> {
	return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

/** The Google authorization URL for state; Google returns the browser to HUB_ORIGIN/account/google/callback. */
export async function googleAuthorizeUrl(env: Env, state: string, verifier: string): Promise<string> {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID ?? "");
	url.searchParams.set("redirect_uri", `${env.HUB_ORIGIN}${GOOGLE_CALLBACK_PATH}`);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", "openid email");
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", await codeChallenge(verifier));
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("prompt", "select_account");
	return url.toString();
}

function field(body: unknown, name: string): unknown {
	return typeof body === "object" && body !== null && name in body ? (body as Record<string, unknown>)[name] : undefined;
}

/** Trades the callback code for the signed-in Google identity; throws google_failed (502) when Google refuses or answers an unexpected shape. */
export async function fetchGoogleIdentity(env: Env, fetcher: Fetcher, code: string, verifier: string): Promise<GoogleIdentity> {
	const tokenRes = await fetcher(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "hookci-hub" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: env.GOOGLE_CLIENT_ID ?? "",
			client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
			redirect_uri: `${env.HUB_ORIGIN}${GOOGLE_CALLBACK_PATH}`,
		}),
	});
	if (!tokenRes.ok) throw new HubError("google_failed", 502, `Google token exchange answered ${tokenRes.status}`);
	const accessToken = field(await tokenRes.json(), "access_token");
	if (typeof accessToken !== "string" || accessToken === "") throw new HubError("google_failed", 502, "Google token exchange gave no access_token");

	const infoRes = await fetcher(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "hookci-hub" } });
	if (!infoRes.ok) throw new HubError("google_failed", 502, `Google userinfo answered ${infoRes.status}`);
	const info: unknown = await infoRes.json();
	const sub = field(info, "sub");
	const email = field(info, "email");
	if (typeof sub !== "string" || sub === "" || typeof email !== "string" || email === "") {
		throw new HubError("google_failed", 502, "Google userinfo lacked sub or email");
	}
	// Only a boolean true counts; Google has also sent the string "true" in some APIs, which this refuses.
	return { sub, email, emailVerified: field(info, "email_verified") === true };
}
