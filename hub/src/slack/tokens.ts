// Slack bot tokens at rest: AES-GCM under TOKEN_ENC_KEYS, bound to the team
// through the additional data, so a ciphertext moved to another row fails.

import { decryptToken, encryptToken, parseEncKeys } from "../crypto";
import { getWorkspace, upsertWorkspace } from "../db/workspaces";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import type { SlackOAuthResult } from "./oauth";

/** The additional authenticated data for team teamId's bot token. */
export function workspaceAad(teamId: string): string {
	return `workspace:${teamId}`;
}

/** Saves the workspace as active with its bot token encrypted under the current key; a reinstall replaces the row. */
export async function storeWorkspace(env: Env, result: SlackOAuthResult, installedBy: string): Promise<void> {
	const { ct, keyVersion } = await encryptToken(parseEncKeys(env.TOKEN_ENC_KEYS), result.botToken, workspaceAad(result.teamId));
	await upsertWorkspace(env.DB, {
		team_id: result.teamId,
		team_name: result.teamName,
		bot_user_id: result.botUserId,
		bot_token_ct: ct,
		key_version: keyVersion,
		installed_by: installedBy,
		status: "active",
		created_at: (env.__TEST_CLOCK ?? systemClock).now(),
	});
}

/**
 * The workspace's bot token. Throws workspace_not_found (404) for an unknown
 * team and workspace_inactive (410) once it is revoked or uninstalled.
 */
export async function getBotToken(env: Env, teamId: string): Promise<string> {
	const row = await getWorkspace(env.DB, teamId);
	if (!row) throw new HubError("workspace_not_found", 404, `no Slack workspace ${teamId}`);
	if (row.status !== "active") throw new HubError("workspace_inactive", 410, `Slack workspace ${teamId} is ${row.status}`);
	return decryptToken(parseEncKeys(env.TOKEN_ENC_KEYS), row.bot_token_ct, row.key_version, workspaceAad(teamId));
}
