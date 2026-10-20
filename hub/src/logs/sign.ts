// Signed log links: `${HUB_ORIGIN}/logs/<run>/<job>?exp=&sig=`, valid 15 minutes.
// The sig is HMAC-SHA256 over `<run>|<job>|<exp>` under LOG_SIGNING_KEYS.

import { base64Bytes, base64url, hmacSha256, timingSafeEqual } from "../crypto";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { checkJobName } from "./keys";

export const LOG_URL_TTL_SECONDS = 900;

const MIN_KEY_BYTES = 32;

function logKeysInvalid(message: string): HubError {
	return new HubError("log_keys_invalid", 500, `LOG_SIGNING_KEYS: ${message}`);
}

/**
 * Parses LOG_SIGNING_KEYS, `{"1":"<base64>","2":"<base64>"}`, into keys newest
 * version first. Throws log_keys_invalid (500) unless there is at least one key
 * and every key is 32 or more bytes of base64 under a positive integer version.
 */
export function parseLogKeys(raw: string): Uint8Array[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw logKeysInvalid("not JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw logKeysInvalid("not an object");
	const keys: { version: number; bytes: Uint8Array }[] = [];
	for (const [version, key] of Object.entries(parsed)) {
		if (!/^[1-9][0-9]{0,8}$/.test(version)) throw logKeysInvalid(`key version "${version}" is not a positive integer`);
		const bytes = typeof key === "string" ? base64Bytes(key) : null;
		if (!bytes || bytes.byteLength < MIN_KEY_BYTES) throw logKeysInvalid(`key ${version} is not ${MIN_KEY_BYTES} or more bytes of base64`);
		keys.push({ version: Number(version), bytes });
	}
	if (keys.length === 0) throw logKeysInvalid("no keys");
	return keys.sort((a, b) => b.version - a.version).map((k) => k.bytes);
}

/** A link to the job's log, signed with the newest key and expiring LOG_URL_TTL_SECONDS after now (ms). */
export async function signLogUrl(env: Env, runId: string, job: string, now: number = (env.__TEST_CLOCK ?? systemClock).now()): Promise<string> {
	checkJobName(job);
	const [current] = parseLogKeys(env.LOG_SIGNING_KEYS);
	if (!current) throw logKeysInvalid("no keys");
	const exp = Math.floor(now / 1000) + LOG_URL_TTL_SECONDS;
	const sig = base64url(await hmacSha256(current, `${runId}|${job}|${exp}`));
	return `${env.HUB_ORIGIN}/logs/${encodeURIComponent(runId)}/${job}?exp=${exp}&sig=${sig}`;
}

export type LogSigStatus = "ok" | "invalid" | "expired";

/** Checks sig against the current and previous key, then exp (unix s) against now (ms). */
export async function logSigStatus(env: Env, runId: string, job: string, exp: number, sig: string, now: number): Promise<LogSigStatus> {
	if (!Number.isSafeInteger(exp)) return "invalid";
	const message = `${runId}|${job}|${exp}`;
	let matched = false;
	for (const key of parseLogKeys(env.LOG_SIGNING_KEYS).slice(0, 2)) {
		if (timingSafeEqual(base64url(await hmacSha256(key, message)), sig)) matched = true;
	}
	if (!matched) return "invalid";
	return exp * 1000 > now ? "ok" : "expired";
}

export async function verifyLogSig(
	env: Env,
	runId: string,
	job: string,
	exp: number,
	sig: string,
	now: number = (env.__TEST_CLOCK ?? systemClock).now(),
): Promise<boolean> {
	return (await logSigStatus(env, runId, job, exp, sig, now)) === "ok";
}
