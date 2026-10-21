import { hex, hmacSha256, timingSafeEqual } from "../crypto";

const PREFIX = "sha256=";

/**
 * Whether header is the `X-Hub-Signature-256` value (`sha256=<hex HMAC-SHA256>`)
 * of rawBody under any of secrets. Several secrets let a rotation accept the
 * previous secret until GitHub sends the new one.
 */
export async function verifyGithubSignature(rawBody: ArrayBuffer, header: string | null, secrets: string[]): Promise<boolean> {
	if (!header?.startsWith(PREFIX)) return false;
	const given = header.slice(PREFIX.length);
	for (const secret of secrets) {
		if (timingSafeEqual(hex(await hmacSha256(secret, rawBody)), given)) return true;
	}
	return false;
}
