import { base64url } from "../crypto";
import { HubError } from "../errors";

const utf8 = new TextEncoder();

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
 * drift and the token lives 9 minutes, under GitHub's 10 minute maximum.
 */
export async function appJwt(appId: string, pkcs8Pem: string, now = Date.now()): Promise<string> {
	const key = await importSigningKey(pkcs8Pem);
	const iat = Math.floor(now / 1000) - 60;
	const header = base64url(utf8.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const claims = base64url(utf8.encode(JSON.stringify({ iat, exp: iat + 540, iss: appId })));
	const signingInput = `${header}.${claims}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8.encode(signingInput));
	return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
