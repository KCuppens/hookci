const utf8 = new TextEncoder();

export async function hmacSha256(key: string | ArrayBuffer, data: string | ArrayBuffer): Promise<ArrayBuffer> {
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

const TOKEN_RE = /(ghs_|ghp_|gho_|ghu_|xoxb-|xoxp-|zc_pair_|zc_agent_)[A-Za-z0-9_-]+/g;

/** Replaces the secret part of GitHub, Slack and ZeroCI tokens, keeping the prefix. */
export function redact(s: string): string {
	return s.replace(TOKEN_RE, "$1[redacted]");
}
