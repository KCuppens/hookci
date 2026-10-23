import { base64url } from "../crypto";
import { HubError } from "../errors";

const utf8 = new TextEncoder();
/** How long a signed JWT is handed out again; it stays valid at least 3 minutes past that. */
const JWT_REUSE_MS = 5 * 60 * 1000;

// Imported signing keys, once per isolate, by PEM.
const signingKeys = new Map<string, Promise<CryptoKey>>();
// The last JWT signed per app id and PEM, with the time it was signed.
const signedJwts = new Map<string, { jwt: string; signedAt: number }>();

function pemToDer(pem: string): Uint8Array {
	const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
	return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

async function importSigningKey(pkcs8Pem: string): Promise<CryptoKey> {
	if (pkcs8Pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
		throw new HubError("github_key_format", 500, "convert key with openssl pkcs8 -topk8 -nocrypt");
	}
	try {
		return await crypto.subtle.importKey(
			"pkcs8",
			pemToDer(pkcs8Pem),
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["sign"],
		);
	} catch {
		throw new HubError("github_key_format", 500, "GITHUB_APP_PRIVATE_KEY is not a PKCS#8 RSA private key PEM");
	}
}

/**
 * RS256 JWT authenticating as the GitHub App. iat is backdated 60 s for clock
 * drift and the token lives 9 minutes, under GitHub's 10 minute maximum. A
 * JWT signed up to JWT_REUSE_MS before now is returned again.
 */
export async function appJwt(appId: string, pkcs8Pem: string, now = Date.now()): Promise<string> {
	const id = `${appId}\n${pkcs8Pem}`;
	const cached = signedJwts.get(id);
	if (cached && now >= cached.signedAt && now - cached.signedAt <= JWT_REUSE_MS) return cached.jwt;

	let key = signingKeys.get(pkcs8Pem);
	if (!key) {
		key = importSigningKey(pkcs8Pem);
		signingKeys.set(pkcs8Pem, key);
	}
	const iat = Math.floor(now / 1000) - 60;
	const header = base64url(utf8.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const claims = base64url(utf8.encode(JSON.stringify({ iat, exp: iat + 540, iss: appId })));
	const signingInput = `${header}.${claims}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await key, utf8.encode(signingInput));
	const jwt = `${signingInput}.${base64url(new Uint8Array(signature))}`;
	signedJwts.set(id, { jwt, signedAt: now });
	return jwt;
}
