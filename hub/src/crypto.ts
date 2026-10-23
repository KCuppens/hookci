import { HubError } from "./errors";

const utf8 = new TextEncoder();

export async function hmacSha256(key: string | ArrayBuffer | Uint8Array, data: string | ArrayBuffer): Promise<ArrayBuffer> {
	const rawKey = typeof key === "string" ? utf8.encode(key) : key;
	const k = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", k, typeof data === "string" ? utf8.encode(data) : data);
}

export function hex(buf: ArrayBuffer | Uint8Array): string {
	const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let out = "";
	for (const b of view) out += b.toString(16).padStart(2, "0");
	return out;
}

/**
 * Compares the UTF-8 bytes of a and b in time that depends only on the longer
 * input, so neither a mismatch position nor a length difference leaks.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	const ab = utf8.encode(a);
	const bb = utf8.encode(b);
	const len = Math.max(ab.byteLength, bb.byteLength);
	const pa = new Uint8Array(len);
	const pb = new Uint8Array(len);
	pa.set(ab);
	pb.set(bb);
	const same = crypto.subtle.timingSafeEqual(pa, pb);
	return same && ab.byteLength === bb.byteLength;
}

export async function sha256Hex(s: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", utf8.encode(s)));
}

/** Unpadded RFC 4648 base64url of bytes. */
export function base64url(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = "";
	for (const b of view) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** prefix followed by `bytes` random bytes in unpadded lowercase RFC 4648 base32. */
export function randomToken(prefix: string, bytes = 16): string {
	const buf = crypto.getRandomValues(new Uint8Array(bytes));
	let out = prefix;
	let acc = 0;
	let bits = 0;
	for (const b of buf) {
		acc = (acc << 8) | b;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += BASE32[(acc >>> bits) & 31];
		}
	}
	if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
	return out;
}

const TOKEN_RE = /(ghs_|ghp_|gho_|ghu_|xoxb-|xoxp-|hci_pair_|hci_agent_)[A-Za-z0-9_-]+/g;

/** Replaces the secret part of GitHub, Slack and HookCI tokens, keeping the prefix. */
export function redact(s: string): string {
	return s.replace(TOKEN_RE, "$1[redacted]");
}

/** Parsed TOKEN_ENC_KEYS: AES-256 keys as standard base64 by version; new ciphertext uses `current`. */
export interface EncKeys {
	current: number;
	keys: Record<string, string>;
}

const AES_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function encKeysInvalid(message: string): HubError {
	return new HubError("enc_keys_invalid", 500, `TOKEN_ENC_KEYS: ${message}`);
}

/** The bytes of standard base64 b64, or null when it is not base64. */
export function base64Bytes(b64: string): Uint8Array | null {
	try {
		return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses TOKEN_ENC_KEYS, `{"current":2,"keys":{"1":"<base64>","2":"<base64>"}}`.
 * Throws enc_keys_invalid (500) unless current is a positive integer with a key
 * and every key is 32 bytes of base64 under a positive integer version.
 */
export function parseEncKeys(raw: string): EncKeys {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw encKeysInvalid("not JSON");
	}
	if (!isObject(parsed)) throw encKeysInvalid("not an object");
	const { current, keys } = parsed;
	if (typeof current !== "number" || !Number.isSafeInteger(current) || current < 1) throw encKeysInvalid("current must be a positive integer");
	if (!isObject(keys)) throw encKeysInvalid("keys must be an object");
	const out: Record<string, string> = {};
	for (const [version, key] of Object.entries(keys)) {
		if (!/^[1-9][0-9]{0,8}$/.test(version)) throw encKeysInvalid(`key version "${version}" is not a positive integer`);
		if (typeof key !== "string" || base64Bytes(key)?.byteLength !== AES_KEY_BYTES) throw encKeysInvalid(`key ${version} is not 32 bytes of base64`);
		out[version] = key;
	}
	if (out[String(current)] === undefined) throw encKeysInvalid(`no key for current version ${current}`);
	return { current, keys: out };
}

// Imported AES keys, once per isolate, by version and key material.
const aesKeys = new Map<string, Promise<CryptoKey>>();

async function aesKey(keys: EncKeys, version: number): Promise<CryptoKey> {
	const b64 = keys.keys[String(version)];
	if (b64 === undefined) throw encKeysInvalid(`no key for version ${version}`);
	const id = `${version}:${b64}`;
	let key = aesKeys.get(id);
	if (!key) {
		const raw = base64Bytes(b64);
		if (raw?.byteLength !== AES_KEY_BYTES) throw encKeysInvalid(`key ${version} is not 32 bytes of base64`);
		key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
		aesKeys.set(id, key);
	}
	return key;
}

/** AES-256-GCM under the current key: ct is a random 12-byte IV, then the ciphertext and 16-byte tag. aad must match on decrypt. */
export async function encryptToken(keys: EncKeys, plaintext: string, aad: string): Promise<{ ct: Uint8Array; keyVersion: number }> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: utf8.encode(aad) },
		await aesKey(keys, keys.current),
		utf8.encode(plaintext),
	);
	const ct = new Uint8Array(IV_BYTES + sealed.byteLength);
	ct.set(iv);
	ct.set(new Uint8Array(sealed), IV_BYTES);
	return { ct, keyVersion: keys.current };
}

/** Opens ct from encryptToken with key keyVersion. Throws token_decrypt_failed (500) when ct or aad was altered. */
export async function decryptToken(keys: EncKeys, ct: Uint8Array, keyVersion: number, aad: string): Promise<string> {
	const key = await aesKey(keys, keyVersion);
	const failed = new HubError("token_decrypt_failed", 500, `ciphertext for ${aad} under key ${keyVersion} failed authentication`);
	if (ct.byteLength < IV_BYTES + TAG_BYTES) throw failed;
	let plain: ArrayBuffer;
	try {
		plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ct.subarray(0, IV_BYTES), additionalData: utf8.encode(aad) }, key, ct.subarray(IV_BYTES));
	} catch {
		throw failed;
	}
	return new TextDecoder().decode(plain);
}
