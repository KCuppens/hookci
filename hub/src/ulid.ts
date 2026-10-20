// Sortable identifiers in the agent's run id format (agent/internal/ids): 26
// lowercase Crockford base32 characters, 48-bit millisecond time then 80
// random bits.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_CHARS = 10;
const MAX_TIME = 2 ** 48 - 1;

/**
 * The time part every ULID of millisecond ms starts with. A ULID of an earlier
 * millisecond sorts before it and one of ms or later sorts after it.
 */
export function ulidTimePrefix(ms: number): string {
	if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIME) throw new RangeError(`ulid time out of range: ${ms}`);
	let time = "";
	for (let i = 0, rest = ms; i < TIME_CHARS; i++, rest = Math.floor(rest / 32)) time = ALPHABET.charAt(rest % 32) + time;
	return time;
}

/** A new ULID for the millisecond now; ids of a later millisecond sort after those of an earlier one. */
export function ulid(now: number = Date.now()): string {
	const time = ulidTimePrefix(now);

	let random = "";
	let acc = 0;
	let bits = 0;
	for (const byte of crypto.getRandomValues(new Uint8Array(10))) {
		acc = (acc << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			random += ALPHABET.charAt((acc >> bits) & 31);
		}
		acc &= (1 << bits) - 1;
	}
	return time + random;
}
