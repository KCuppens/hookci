import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ManifestConversion } from "../../cli/manifest-flow.js";

export interface FakeGithubCall {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: string;
}

export interface FakeGithub {
	url: string;
	calls: FakeGithubCall[];
	close(): Promise<void>;
	/** Overrides for the next conversion; `pem` replaces the signing key GET /app checks against too. */
	nextConversion: Partial<ManifestConversion>;
}

const DEFAULTS: Omit<ManifestConversion, "pem"> = {
	id: 424242,
	slug: "acme-hookci",
	webhook_secret: "whsec-fake-0f9e8d7c",
	client_id: "Iv1.fakeclientid0001",
	client_secret: "fake-client-secret-5a4b3c2d1e",
	html_url: "https://github.com/apps/acme-hookci",
};

/** Checks an RS256 JWT against `publicKey` and returns its claims, or null. */
function verifiedClaims(jwt: string, publicKey: string): Record<string, unknown> | null {
	const [head, payload, sig] = jwt.split(".");
	if (!head || !payload || !sig) return null;
	const ok = createVerify("RSA-SHA256").update(`${head}.${payload}`).verify(publicKey, Buffer.from(sig, "base64url"));
	return ok ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>) : null;
}

/**
 * A loopback stand-in for api.github.com: `POST /app-manifests/:code/conversions`
 * creates an app with a fresh RSA key, as PKCS#1 PEM like GitHub (code `bad` is
 * unknown), `GET /app` answers only to a JWT that key signed.
 */
export async function startFakeGithub(): Promise<FakeGithub> {
	const calls: FakeGithubCall[] = [];
	let app: ManifestConversion | undefined;
	let publicKey = "";
	const fake: FakeGithub = { url: "", calls, close: async () => {}, nextConversion: {} };

	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		const path = req.url ?? "/";
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
		calls.push({ method: req.method ?? "", path, headers, body });
		const json = (status: number, value: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(value));
		};

		const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
		if (req.method === "POST" && conversion) {
			if (conversion[1] === "bad") return json(404, { message: "Not Found" });
			const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
			publicKey = keys.publicKey;
			app = { ...DEFAULTS, pem: keys.privateKey, ...fake.nextConversion };
			return json(201, app);
		}
		if (req.method === "GET" && path === "/app") {
			const token = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
			const claims = token && app ? verifiedClaims(token, publicKey) : null;
			if (!app || !claims || claims.iss !== app.id) return json(401, { message: "A JSON web token could not be decoded" });
			return json(200, { id: app.id, slug: app.slug, html_url: app.html_url });
		}
		json(404, { message: "Not Found" });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	fake.close = () =>
		new Promise((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	return fake;
}

/**
 * Plays the user's browser: loads the local manifest page, reads the state
 * GitHub would echo back, and follows GitHub's redirect with `code`.
 */
export function fakeBrowser(code: string, opened: string[] = []): (url: string) => Promise<void> {
	return async (url) => {
		opened.push(url);
		const page = await (await fetch(url)).text();
		const state = /name="state" value="([0-9a-f]+)"/.exec(page)?.[1] ?? "";
		await fetch(new URL(`/github/manifest/callback?code=${code}&state=${state}`, url));
	};
}
