// Outbound sink configs, with their secrets encrypted at rest, and the
// per-run message and delivery records the SinkOutboxDO keeps for them.

import { decryptToken, type EncKeys, encryptToken, parseEncKeys } from "../crypto";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { ulid } from "../ulid";
import type { TenantDb } from "./tenant";

export type SinkKind = "telegram" | "webhook" | "linear";

/** A sink config as listed; the secret never leaves getSinkConfigWithSecret. */
export interface SinkConfigRow {
	id: string;
	kind: SinkKind;
	repo: string;
	target: string;
	/** The name the user gave the config; null when none. */
	label: string | null;
	/** `slack:<team>:<user>` or `agent:<agent_id>`. */
	createdBy: string;
	createdAt: number;
	disabledAt: number | null;
	disabledReason: string | null;
}

export interface SinkConfigWithSecret extends SinkConfigRow {
	secret: string | null;
}

export interface NewSinkConfig {
	kind: SinkKind;
	repo: string;
	target: string;
	secret: string | null;
	label?: string | null;
	createdBy: string;
}

export interface SinkMessage {
	externalId: string | null;
	lastHash: string | null;
}

export type SinkDeliveryStatus = "ok" | "retrying" | "failed" | "dropped";

export interface SinkDelivery {
	sinkId: string;
	deliveryId: string;
	runId: string;
	attempt: number;
	status: SinkDeliveryStatus;
	httpStatus: number | null;
	at: number;
}

interface StoredSinkConfig {
	id: string;
	kind: SinkKind;
	repo: string;
	target: string;
	label: string | null;
	// D1 returns BLOB columns as arrays of byte values.
	secret_enc: number[] | null;
	key_version: number | null;
	created_by: string;
	created_at: number;
	disabled_at: number | null;
	disabled_reason: string | null;
}

const ROW_COLUMNS = "id, kind, repo, target, label, created_by, created_at, disabled_at, disabled_reason";

function fromStored(row: Omit<StoredSinkConfig, "secret_enc" | "key_version">): SinkConfigRow {
	return {
		id: row.id,
		kind: row.kind,
		repo: row.repo,
		target: row.target,
		label: row.label,
		createdBy: row.created_by,
		createdAt: row.created_at,
		disabledAt: row.disabled_at,
		disabledReason: row.disabled_reason,
	};
}

/** Binds a secret to its installation and config, so ciphertext copied to another row fails to open. */
function sinkAad(installationId: number, id: string): string {
	return `${installationId}:${id}`;
}

/** Stores a new config, encrypting its secret under the current key. */
export async function createSinkConfig(env: Env, t: TenantDb, input: NewSinkConfig): Promise<SinkConfigRow> {
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const id = `snk_${ulid(now)}`;
	const sealed = input.secret === null ? null : await encryptToken(parseEncKeys(env.TOKEN_ENC_KEYS), input.secret, sinkAad(t.installationId, id));
	await t.run(
		`INSERT INTO sink_configs (installation_id, id, kind, repo, target, secret_enc, key_version, created_by, created_at, label)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
		id,
		input.kind,
		input.repo,
		input.target,
		sealed?.ct ?? null,
		sealed?.keyVersion ?? null,
		input.createdBy,
		now,
		input.label ?? null,
	);
	return {
		id,
		kind: input.kind,
		repo: input.repo,
		target: input.target,
		label: input.label ?? null,
		createdBy: input.createdBy,
		createdAt: now,
		disabledAt: null,
		disabledReason: null,
	};
}

/** The enabled configs, of one repo when given, oldest first. */
export async function listSinkConfigs(t: TenantDb, repo?: string): Promise<SinkConfigRow[]> {
	const rows =
		repo === undefined
			? await t.all<StoredSinkConfig>(
					`SELECT ${ROW_COLUMNS} FROM sink_configs WHERE installation_id = ?1 AND disabled_at IS NULL ORDER BY created_at, id`,
				)
			: await t.all<StoredSinkConfig>(
					`SELECT ${ROW_COLUMNS} FROM sink_configs WHERE installation_id = ?1 AND repo = ?2 AND disabled_at IS NULL ORDER BY created_at, id`,
					repo,
				);
	return rows.map(fromStored);
}

/** Every config of the repo, disabled ones too, oldest first. */
export async function listRepoSinkConfigs(t: TenantDb, repo: string): Promise<SinkConfigRow[]> {
	const rows = await t.all<StoredSinkConfig>(
		`SELECT ${ROW_COLUMNS} FROM sink_configs WHERE installation_id = ?1 AND repo = ?2 ORDER BY created_at, id`,
		repo,
	);
	return rows.map(fromStored);
}

/** The config without its secret, disabled or not; null when the installation has none by that id. */
export async function getSinkConfig(t: TenantDb, id: string): Promise<SinkConfigRow | null> {
	const row = await t.first<StoredSinkConfig>(`SELECT ${ROW_COLUMNS} FROM sink_configs WHERE installation_id = ?1 AND id = ?2`, id);
	return row && fromStored(row);
}

/** Deletes the config and its per-run messages; the deleted config, or null when there was none. */
export async function deleteSinkConfig(t: TenantDb, id: string): Promise<SinkConfigRow | null> {
	const row = await t.first<StoredSinkConfig>(`DELETE FROM sink_configs WHERE installation_id = ?1 AND id = ?2 RETURNING ${ROW_COLUMNS}`, id);
	if (!row) return null;
	await t.run("DELETE FROM sink_messages WHERE installation_id = ?1 AND sink_id = ?2", id);
	return fromStored(row);
}

/** The config with its secret decrypted, disabled or not; null when there is none. Throws token_decrypt_failed when the ciphertext does not open. */
export async function getSinkConfigWithSecret(env: Env, t: TenantDb, id: string): Promise<SinkConfigWithSecret | null> {
	const row = await t.first<StoredSinkConfig>("SELECT * FROM sink_configs WHERE installation_id = ?1 AND id = ?2", id);
	if (!row) return null;
	const secret =
		row.secret_enc === null || row.key_version === null
			? null
			: await decryptToken(parseEncKeys(env.TOKEN_ENC_KEYS), new Uint8Array(row.secret_enc), row.key_version, sinkAad(t.installationId, id));
	return { ...fromStored(row), secret };
}

/** A config whose secret is under an old key, as the key rotation cron finds it. */
export interface StaleSinkSecret {
	installationId: number;
	id: string;
	secretEnc: Uint8Array;
	keyVersion: number;
}

/**
 * Up to limit configs of any installation whose secret is not under keyVersion,
 * in (installation_id, id) order after the given row. Cross-tenant: only the
 * key rotation cron calls it.
 */
export async function listStaleSinkSecrets(
	db: D1Database,
	keyVersion: number,
	after: { installationId: number; id: string },
	limit: number,
): Promise<StaleSinkSecret[]> {
	const { results } = await db
		.prepare(
			`SELECT installation_id, id, secret_enc, key_version FROM sink_configs
			WHERE secret_enc IS NOT NULL AND key_version != ?1 AND (installation_id, id) > (?2, ?3)
			ORDER BY installation_id, id LIMIT ?4`,
		)
		.bind(keyVersion, after.installationId, after.id, limit)
		.all<{ installation_id: number; id: string; secret_enc: number[]; key_version: number }>();
	return results.map((r) => ({ installationId: r.installation_id, id: r.id, secretEnc: new Uint8Array(r.secret_enc), keyVersion: r.key_version }));
}

/**
 * Re-encrypts the secret under the current key. Applies only while the row
 * still has the version it was listed with; false when it did not apply.
 * Throws token_decrypt_failed when the ciphertext does not open.
 */
export async function reencryptSinkSecret(db: D1Database, keys: EncKeys, stale: StaleSinkSecret): Promise<boolean> {
	const aad = sinkAad(stale.installationId, stale.id);
	const secret = await decryptToken(keys, stale.secretEnc, stale.keyVersion, aad);
	const { ct, keyVersion } = await encryptToken(keys, secret, aad);
	const res = await db
		.prepare("UPDATE sink_configs SET secret_enc = ?1, key_version = ?2 WHERE installation_id = ?3 AND id = ?4 AND key_version = ?5")
		.bind(ct, keyVersion, stale.installationId, stale.id, stale.keyVersion)
		.run();
	return res.meta.changes > 0;
}

/** Stops deliveries to the config; false when it does not exist or was already disabled. */
export async function disableSinkConfig(t: TenantDb, id: string, reason: string, now: number): Promise<boolean> {
	const res = await t.run(
		"UPDATE sink_configs SET disabled_at = ?3, disabled_reason = ?4 WHERE installation_id = ?1 AND id = ?2 AND disabled_at IS NULL",
		id,
		now,
		reason,
	);
	return res.meta.changes > 0;
}

/** The provider message the sink keeps for the run; null before its first delivery. */
export async function getSinkMessage(t: TenantDb, sinkId: string, runId: string): Promise<SinkMessage | null> {
	const row = await t.first<{ external_id: string | null; last_hash: string | null }>(
		"SELECT external_id, last_hash FROM sink_messages WHERE installation_id = ?1 AND sink_id = ?2 AND run_id = ?3",
		sinkId,
		runId,
	);
	return row && { externalId: row.external_id, lastHash: row.last_hash };
}

export async function putSinkMessage(t: TenantDb, sinkId: string, runId: string, msg: SinkMessage, now: number): Promise<void> {
	await t.run(
		`INSERT INTO sink_messages (installation_id, sink_id, run_id, external_id, last_hash, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
		ON CONFLICT (installation_id, sink_id, run_id) DO UPDATE SET external_id = excluded.external_id, last_hash = excluded.last_hash,
			updated_at = excluded.updated_at`,
		sinkId,
		runId,
		msg.externalId,
		msg.lastHash,
		now,
	);
}

/** Records one delivery attempt; recording the same attempt again keeps the first. */
export async function recordDelivery(t: TenantDb, d: SinkDelivery): Promise<void> {
	await t.run(
		`INSERT OR IGNORE INTO sink_deliveries (installation_id, sink_id, delivery_id, run_id, attempt, status, http_status, at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
		d.sinkId,
		d.deliveryId,
		d.runId,
		d.attempt,
		d.status,
		d.httpStatus,
		d.at,
	);
}
