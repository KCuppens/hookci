import type { Env } from "../env";
import { HubError } from "../errors";
import type { Fetcher } from "../http";

export interface OAuthToken {
	access_token: string;
	refresh_token?: string;
	/** Seconds until access_token expires. */
	expires_in?: number;
}

/**
 * Exchanges an OAuth callback code for a user-to-server token. GitHub answers
 * a bad or expired code with 200 and an `error` field, so both that and a
 * non-200 throw github_oauth_failed.
 */
export async function exchangeCode(env: Env, fetcher: Fetcher, code: string): Promise<OAuthToken> {
	const res = await fetcher("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "zeroci-hub" },
		body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
	});
	if (!res.ok) throw new HubError("github_oauth_failed", 502, `GitHub token exchange answered ${res.status}`);
	const body: unknown = await res.json();
	if (typeof body !== "object" || body === null) {
		throw new HubError("github_oauth_failed", 502, "GitHub token exchange answered a non-object");
	}
	if (!("access_token" in body) || typeof body.access_token !== "string") {
		const error = "error" in body && typeof body.error === "string" ? body.error : "no access_token";
		throw new HubError("github_oauth_failed", 502, `GitHub token exchange failed: ${error}`);
	}
	const token: OAuthToken = { access_token: body.access_token };
	if ("refresh_token" in body && typeof body.refresh_token === "string") token.refresh_token = body.refresh_token;
	if ("expires_in" in body && typeof body.expires_in === "number") token.expires_in = body.expires_in;
	return token;
}
