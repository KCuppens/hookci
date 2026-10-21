// Slack OAuth v2 for the bot install: the authorize URL, the code exchange and
// revoking a token HookCI will not keep. Bot scopes only; no user scopes.

import type { Env } from "../env";
import { HubError } from "../errors";
import type { Fetcher } from "../http";

/** The bot scopes HookCI asks for, comma separated as Slack's `scope` parameter wants them. */
export const SLACK_BOT_SCOPES = "chat:write,commands,channels:read,groups:read,im:write,users:read,users:read.email";

/** Lets the bot post in channels it was never invited to; HookCI must never hold it. */
const FORBIDDEN_SCOPE = "chat:write.public";

export interface SlackOAuthResult {
	/** Empty for an org-wide Enterprise Grid install, which names no team. */
	teamId: string;
	/** Empty for an org-wide Enterprise Grid install, which names no team. */
	teamName: string;
	enterpriseId: string | null;
	isEnterpriseInstall: boolean;
	botUserId: string;
	botToken: string;
	/** The bot scopes Slack granted, comma separated. */
	scope: string;
	/** The Slack user who approved the install. */
	authedUserId: string;
}

/** The Slack consent page URL. The scope list goes in unencoded so it reads as Slack documents it. */
export function slackAuthorizeUrl(env: Env, state: string): string {
	const redirectUri = encodeURIComponent(`${env.HUB_ORIGIN}/slack/oauth/callback`);
	return `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(env.SLACK_CLIENT_ID)}&scope=${SLACK_BOT_SCOPES}&redirect_uri=${redirectUri}&state=${encodeURIComponent(state)}`;
}

/** Whether granted holds every bot scope HookCI asks for and not chat:write.public. */
export function grantedScopesMatch(granted: string): boolean {
	const scopes = new Set(granted.split(",").map((s) => s.trim()));
	return !scopes.has(FORBIDDEN_SCOPE) && SLACK_BOT_SCOPES.split(",").every((s) => scopes.has(s));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exchangeFailed(reason: string): HubError {
	return new HubError("slack_oauth_failed", 502, `Slack oauth.v2.access failed: ${reason}`);
}

/**
 * Exchanges the callback code for a bot token. Slack answers a bad code with
 * 200 and `ok: false`, so that, a non-200 and a malformed body all throw
 * slack_oauth_failed.
 */
export async function exchangeSlackCode(env: Env, fetcher: Fetcher, code: string): Promise<SlackOAuthResult> {
	const res = await fetcher("https://slack.com/api/oauth.v2.access", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.SLACK_CLIENT_ID,
			client_secret: env.SLACK_CLIENT_SECRET,
			code,
			redirect_uri: `${env.HUB_ORIGIN}/slack/oauth/callback`,
		}).toString(),
	});
	if (!res.ok) throw exchangeFailed(`HTTP ${res.status}`);
	const body: unknown = await res.json().catch(() => null);
	if (!isObject(body)) throw exchangeFailed("not a JSON object");
	if (body.ok !== true) throw exchangeFailed(typeof body.error === "string" ? body.error : "ok is not true");

	const isEnterpriseInstall = body.is_enterprise_install === true;
	const team: Record<string, unknown> = isObject(body.team) ? body.team : {};
	const enterprise = isObject(body.enterprise) ? body.enterprise : null;
	const authedUserId = isObject(body.authed_user) ? body.authed_user.id : undefined;
	const { access_token: botToken, bot_user_id: botUserId, scope } = body;
	const { id: teamId, name: teamName } = team;
	const enterpriseId = enterprise?.id;
	if (typeof botToken !== "string" || typeof botUserId !== "string" || typeof scope !== "string") {
		throw exchangeFailed("no bot token, bot user or scope");
	}
	if (typeof authedUserId !== "string") throw exchangeFailed("no authed_user.id");
	if (enterprise !== null && typeof enterpriseId !== "string") throw exchangeFailed("enterprise without an id");
	const hasTeam = typeof teamId === "string" && typeof teamName === "string";
	if (!hasTeam && !isEnterpriseInstall) throw exchangeFailed("no team");
	return {
		teamId: typeof teamId === "string" ? teamId : "",
		teamName: typeof teamName === "string" ? teamName : "",
		enterpriseId: typeof enterpriseId === "string" ? enterpriseId : null,
		isEnterpriseInstall,
		botUserId,
		botToken,
		scope,
		authedUserId,
	};
}

/** Revokes token with auth.revoke. Throws slack_revoke_failed when Slack does not confirm it. */
export async function revokeSlackToken(fetcher: Fetcher, token: string): Promise<void> {
	const res = await fetcher("https://slack.com/api/auth.revoke", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
		body: "",
	});
	const body: unknown = await res.json().catch(() => null);
	if (!res.ok || !isObject(body) || body.ok !== true) {
		const reason = isObject(body) && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
		throw new HubError("slack_revoke_failed", 502, `Slack auth.revoke failed: ${reason}`);
	}
}
