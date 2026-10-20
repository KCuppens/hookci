// Moves Slack bot tokens onto the current TOKEN_ENC_KEYS version after a key
// rotation, a batch per cron tick. The old key stays in TOKEN_ENC_KEYS until a
// pass finds nothing left to move.

import { decryptToken, encryptToken, parseEncKeys } from "../crypto";
import { getCronState, setCronState } from "../db/cron-state";
import type { Env } from "../env";
import { logEvent, reportError } from "../observability";
import { workspaceAad } from "../slack/tokens";

const BATCH = 100;
/** cron_state key: the team_id the last batch ended at, so a row that keeps failing cannot hold back the rows after it. */
const CURSOR_KEY = "reencrypt_after";

interface StaleToken {
	team_id: string;
	// D1 returns BLOB columns as arrays of byte values.
	bot_token_ct: number[];
	key_version: number;
}

/**
 * Re-encrypts up to limit tokens that are not under the current key version
 * and returns how many it moved. Batches walk team_id order from where the
 * last one ended and start over after the last row. The update only applies
 * while the row still has the version it was read with, so a reinstall in
 * between wins. A row that fails is reported and skipped.
 */
export async function reencryptTokens(env: Env, now: number, limit = BATCH): Promise<number> {
	const keys = parseEncKeys(env.TOKEN_ENC_KEYS);
	const after = (await getCronState(env.DB, CURSOR_KEY)) ?? "";
	const { results } = await env.DB.prepare(
		`SELECT team_id, bot_token_ct, key_version FROM workspaces
		WHERE key_version != ?1 AND bot_token_ct IS NOT NULL AND team_id > ?3 ORDER BY team_id LIMIT ?2`,
	)
		.bind(keys.current, limit, after)
		.all<StaleToken>();
	await setCronState(env.DB, CURSOR_KEY, results.length < limit ? "" : (results.at(-1)?.team_id ?? ""), now);
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
