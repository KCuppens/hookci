// Moves Slack bot tokens onto the current TOKEN_ENC_KEYS version after a key
// rotation, a batch per cron tick. The old key stays in TOKEN_ENC_KEYS until a
// pass finds nothing left to move.

import { decryptToken, encryptToken, parseEncKeys } from "../crypto";
import type { Env } from "../env";
import { logEvent, reportError } from "../observability";
import { workspaceAad } from "../slack/tokens";

const BATCH = 100;

interface StaleToken {
	team_id: string;
	// D1 returns BLOB columns as arrays of byte values.
	bot_token_ct: number[];
	key_version: number;
}

/**
 * Re-encrypts up to limit tokens that are not under the current key version
 * and returns how many it moved. The update only applies while the row still
 * has the version it was read with, so a reinstall in between wins. A row that
 * fails is reported and skipped.
 */
export async function reencryptTokens(env: Env, limit = BATCH): Promise<number> {
	const keys = parseEncKeys(env.TOKEN_ENC_KEYS);
	const { results } = await env.DB.prepare(
		"SELECT team_id, bot_token_ct, key_version FROM workspaces WHERE key_version != ?1 AND bot_token_ct IS NOT NULL LIMIT ?2",
	)
		.bind(keys.current, limit)
		.all<StaleToken>();
	let count = 0;
	for (const row of results) {
		try {
			const aad = workspaceAad(row.team_id);
			const token = await decryptToken(keys, new Uint8Array(row.bot_token_ct), row.key_version, aad);
			const { ct, keyVersion } = await encryptToken(keys, token, aad);
			const res = await env.DB.prepare("UPDATE workspaces SET bot_token_ct = ?1, key_version = ?2 WHERE team_id = ?3 AND key_version = ?4")
				.bind(ct, keyVersion, row.team_id, row.key_version)
				.run();
			count += res.meta.changes;
		} catch (err) {
			reportError(err, { task: "reencrypt", team_id: row.team_id });
		}
	}
	logEvent("reencrypt", { count });
	return count;
}
