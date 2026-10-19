// Sortable identifiers in the agent's run id format (agent/internal/ids): 26
// lowercase Crockford base32 characters, 48-bit millisecond time then 80
// random bits.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_CHARS = 10;
const MAX_TIME = 2 ** 48 - 1;

/** A new ULID for the millisecond now; ids of a later millisecond sort after those of an earlier one. */
export function ulid(now: number = Date.now()): string {
	if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIME) throw new RangeError(`ulid time out of range: ${now}`);
	let time = "";
	for (let i = 0, ms = now; i < TIME_CHARS; i++, ms = Math.floor(ms / 32)) time = ALPHABET.charAt(ms % 32) + time;

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
