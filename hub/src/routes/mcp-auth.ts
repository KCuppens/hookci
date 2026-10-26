// The MCP endpoint's bearer auth: `Authorization: Bearer hci_mcp_...`, or the
// token as the last path segment for clients that cannot set headers.

import { API_TOKEN_PREFIX, type ApiTokenRow, apiTokenHash, getApiTokenByHash, touchApiToken } from "../db/api-tokens";
import { getInstallation } from "../db/installations";
import type { Env } from "../env";
import { HubError } from "../errors";

/** The non-revoked token presented as authorization or pathToken; throws auth_failed (401) otherwise. */
export async function authenticateMcpToken(env: Env, authorization: string | undefined, pathToken: string | undefined): Promise<ApiTokenRow> {
	const credential = authorization?.match(/^Bearer (\S+)$/)?.[1] ?? pathToken;
	if (!credential?.startsWith(API_TOKEN_PREFIX)) throw new HubError("auth_failed", 401);
	const row = await getApiTokenByHash(env.DB, await apiTokenHash(credential));
	if (!row || row.revoked_at !== null) throw new HubError("auth_failed", 401);
	const installation = await getInstallation(env.DB, row.installation_id);
	if (!installation || installation.deleted_at !== null || installation.suspended_at !== null) {
		throw new HubError("auth_failed", 401);
	}
	return row;
}
const TOUCH_INTERVAL_MS = 60_000;

/** Stamps the token's last_used_at without delaying the response, skipping the write when it was touched within TOUCH_INTERVAL_MS; failures are not fatal. */
export function touchMcpToken(env: Env, row: ApiTokenRow, at: number, waitUntil: (p: Promise<unknown>) => void): void {
	if (row.last_used_at !== null && at - row.last_used_at < TOUCH_INTERVAL_MS) return;
	waitUntil(touchApiToken(env.DB, row.installation_id, row.token_id, at).catch(() => undefined));
}
