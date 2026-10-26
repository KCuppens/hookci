// POST /app/:installationId/tokens and its /revoke: the Settings tab's API
// token card. Session-gated like the Settings page itself (scopeOf), with
// the same same-origin csrf form as the run actions. A created token is
// shown once, in a plain no-store page; it is never stored or shown again.

import type { Context } from "hono";
import { readCheckedForm } from "../accounts/csrf";
import { apiTokenHash, generateApiToken, insertApiToken, revokeApiToken } from "../db/api-tokens";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { logEvent } from "../observability";
import { notFoundPage } from "../pages/dashboard";
import { escapeHtml, page } from "../pages/layout";
import { S } from "../strings";
import { scopeOf } from "./dashboard";

type AppContext = Context<{ Bindings: Env }>;

const T = S.apiTokens;
const NAME_MAX = 100;

function refusal(installationId: number, message: string, status: number): Response {
	const back = `/app/${installationId}/settings`;
	return page(T.conflictTitle, `<p>${escapeHtml(message)}</p>\n<p><a href="${escapeHtml(back)}">${escapeHtml(T.backToSettings)}</a></p>`, { status });
}

/** The one-time reveal page: the raw token, shown once, never persisted anywhere else. Cache-Control: no-store (page()'s default). */
function revealPage(installationId: number, name: string, token: string): Response {
	const back = `/app/${installationId}/settings`;
	const body =
		`<p>${escapeHtml(T.revealWarning)}</p>` +
		`<p><code>${escapeHtml(token)}</code></p>` +
		`<p><a href="${escapeHtml(back)}">${escapeHtml(T.backToSettings)}</a></p>`;
	return page(T.revealTitle(name), body, { status: 201 });
}

export async function createApiTokenForm(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const { session, t, account } = scope;
	const form = await readCheckedForm(c.env, c.req.raw);
	if (!form) return refusal(account.id, T.csrf, 403);
	const name = (form.name ?? "").trim().slice(0, NAME_MAX);
	if (!name) return refusal(account.id, T.nameRequired, 400);
	const now = (c.env.__TEST_CLOCK ?? systemClock).now();
	const { tokenId, token } = generateApiToken(now);
	await insertApiToken(t, { token_id: tokenId, token_hash: await apiTokenHash(token), name, created_at: now, created_by_github_id: session.githubUserId });
	logEvent("api_token_created", { installation_id: account.id, actor: session.githubUserId, token_id: tokenId });
	return revealPage(account.id, name, token);
}

export async function revokeApiTokenForm(c: AppContext): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const { session, t, account } = scope;
	const form = await readCheckedForm(c.env, c.req.raw);
	if (!form) return refusal(account.id, T.csrf, 403);
	const tokenId = c.req.param("tokenId") ?? "";
	const now = (c.env.__TEST_CLOCK ?? systemClock).now();
	const revoked = await revokeApiToken(t, tokenId, now);
	if (revoked) logEvent("api_token_revoked", { installation_id: account.id, actor: session.githubUserId, token_id: tokenId });
	return new Response(null, { status: 303, headers: { location: `/app/${account.id}/settings`, "cache-control": "no-store" } });
}
