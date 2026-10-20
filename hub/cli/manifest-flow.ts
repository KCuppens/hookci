import { createPrivateKey, createSign, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { packageRoot } from "./package.js";
import { type SetupOptions, SetupError, deployWorker, putSecret, renderConfig } from "./setup.js";
import { type HubState, saveState } from "./state.js";
import type { Exec } from "./wrangler.js";

export interface GithubManifestOptions {
	baseUrl: string;
	name: string;
	org?: string;
	githubBase?: string;
	apiBase?: string;
}

export interface ManifestConversion {
	id: number;
	slug: string;
	pem: string;
	webhook_secret: string;
	client_id: string;
	client_secret: string;
	html_url: string;
}

export interface SetupContext {
	options: SetupOptions;
	state: HubState;
	exec: Exec;
	log: (line: string) => void;
}

/** Binds `server` to `host:port`; injectable so tests can watch the bind address. */
export type ListenFn = (server: Server, port: number, host: string) => Promise<void>;

const DEFAULT_GITHUB_BASE = "https://github.com";
const DEFAULT_API_BASE = "https://api.github.com";
const LOOPBACK = "127.0.0.1";
const CALLBACK_PATH = "/github/manifest/callback";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const GITHUB_ACCEPT = "application/vnd.github+json";

/** The self-hosted app manifest: the shared app's permissions and events, with every URL on `baseUrl`. */
export function renderGithubManifest(baseUrl: string, name: string): Record<string, unknown> {
	const shared = JSON.parse(readFileSync(join(packageRoot(), "manifests", "github-app.json"), "utf8")) as Record<string, unknown>;
	const base = baseUrl.replace(/\/+$/, "");
	// The hosted manifest's paths, moved onto this hub, so the two lists cannot drift.
	const rebase = (url: unknown): string => {
		const u = new URL(String(url));
		return `${base}${u.pathname}${u.search}`;
	};
	return {
		...shared,
		name,
		url: base,
		hook_attributes: { ...(shared.hook_attributes as Record<string, unknown>), url: `${base}/github/webhook` },
		redirect_url: `${base}/github/manifest/done`,
		callback_urls: (shared.callback_urls as unknown[]).map(rebase),
		setup_url: rebase(shared.setup_url),
		public: false,
	};
}

function htmlEscape(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A page that posts `manifest` to GitHub as soon as it loads. */
export function manifestFormHtml(actionUrl: string, manifest: object, state: string): string {
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Create the zeroci GitHub App</title></head>
<body onload="document.forms[0].submit()">
<form method="post" action="${htmlEscape(actionUrl)}">
<input type="hidden" name="manifest" value="${htmlEscape(JSON.stringify(manifest))}">
<input type="hidden" name="state" value="${htmlEscape(state)}">
<noscript><button type="submit">Create the GitHub App</button></noscript>
</form>
</body></html>
`;
}

export function githubNewAppUrl(opts: GithubManifestOptions, state: string): string {
	const base = (opts.githubBase ?? DEFAULT_GITHUB_BASE).replace(/\/+$/, "");
	const path = opts.org ? `/organizations/${encodeURIComponent(opts.org)}/settings/apps/new` : "/settings/apps/new";
	return `${base}${path}?state=${encodeURIComponent(state)}`;
}

const defaultListen: ListenFn = (server, port, host) =>
	new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

/**
 * Serves the auto-submit page on loopback and waits for GitHub's redirect
 * back with the manifest code. `page` renders `GET /` for the server's
 * origin; `onListening` gets that origin once the port is bound.
 */
export async function awaitManifestCode(opts: {
	state: string;
	port?: number;
	timeoutMs?: number;
	listen?: ListenFn;
	page?: (origin: string) => string;
	onListening?: (origin: string) => void | Promise<void>;
}): Promise<{ code: string; close(): Promise<void> }> {
	let origin = "";
	let settle: { resolve: (code: string) => void; reject: (err: unknown) => void } | undefined;
	const done = new Promise<string>((resolve, reject) => {
		settle = { resolve, reject };
	});
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method === "GET" && url.pathname === "/") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(opts.page?.(origin) ?? "");
			return;
		}
		if (req.method === "GET" && url.pathname === CALLBACK_PATH) {
			const code = url.searchParams.get("code");
			if (url.searchParams.get("state") !== opts.state || !code) {
				res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
				res.end("This link does not belong to the running zeroci-hub setup.\n");
				return;
			}
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end("GitHub App created. Return to the terminal.\n");
			settle?.resolve(code);
			return;
		}
		res.writeHead(404).end();
	});
	await (opts.listen ?? defaultListen)(server, opts.port ?? 0, LOOPBACK);
	origin = `http://${LOOPBACK}:${(server.address() as AddressInfo).port}`;
	const timer = setTimeout(
		() => settle?.reject(new SetupError("manifest_timeout", "no GitHub App was created before the manifest flow timed out")),
		opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	try {
		await opts.onListening?.(origin);
		const code = await done;
		return { code, close: () => closeServer(server) };
	} catch (err) {
		await closeServer(server);
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

function field<T>(v: Record<string, unknown>, key: string, type: "string" | "number"): T {
	if (typeof v[key] !== type) throw new SetupError("manifest_conversion_failed", `GitHub's manifest conversion has no ${key}`);
	return v[key] as T;
}

/** Exchanges the one-time manifest code for the new app's id and credentials. */
export async function convertManifestCode(code: string, fetchFn: typeof fetch, apiBase = DEFAULT_API_BASE): Promise<ManifestConversion> {
	const res = await fetchFn(`${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
		method: "POST",
		headers: { Accept: GITHUB_ACCEPT },
	});
	if (res.status !== 201) throw new SetupError("manifest_conversion_failed", `GitHub answered the manifest conversion with HTTP ${res.status}`);
	const body = (await res.json()) as Record<string, unknown>;
	return {
		id: field(body, "id", "number"),
		slug: field(body, "slug", "string"),
		pem: field(body, "pem", "string"),
		webhook_secret: field(body, "webhook_secret", "string"),
		client_id: field(body, "client_id", "string"),
		client_secret: field(body, "client_secret", "string"),
		html_url: field(body, "html_url", "string"),
	};
}

const b64url = (v: string | Buffer): string => Buffer.from(v).toString("base64url");

/** A GitHub App JWT, valid from a minute ago for ten minutes. */
export function appJwt(appId: number, pem: string, nowSec: number): string {
	const head = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }))}`;
	const signature = createSign("RSA-SHA256").update(head).sign(pem);
	return `${head}.${b64url(signature)}`;
}

/** GitHub's PKCS#1 `pem` as the PKCS#8 PEM the hub's Worker imports (src/github/jwt.ts). */
export function pkcs8Pem(pem: string): string {
	try {
		return createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
	} catch {
		throw new SetupError("manifest_conversion_failed", "GitHub's manifest conversion pem is not a private key");
	}
}

/** Signs in as the new app and checks GitHub reports the same id and slug. */
export async function verifyGithubApp(
	conv: ManifestConversion,
	fetchFn: typeof fetch,
	apiBase = DEFAULT_API_BASE,
	nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
	const res = await fetchFn(`${apiBase}/app`, {
		headers: { Accept: GITHUB_ACCEPT, Authorization: `Bearer ${appJwt(conv.id, conv.pem, nowSec)}` },
	});
	if (res.status !== 200) throw new SetupError("github_app_verify_failed", `GitHub answered GET /app with HTTP ${res.status}`);
	const app = (await res.json()) as Record<string, unknown>;
	if (app.id !== conv.id || app.slug !== conv.slug) {
		throw new SetupError("github_app_verify_failed", `GET /app returned app ${String(app.id)} (${String(app.slug)}), not ${conv.id} (${conv.slug})`);
	}
}

/**
 * Registers the hub's own GitHub App through the manifest flow, stores its
 * credentials as Worker secrets and redeploys with the app's slug. The app's
 * id is saved before any secret is stored: its credentials exist only in this
 * run, so a rerun refuses to create a second app, and resumes at the redeploy
 * once every credential is stored.
 */
export async function githubAppStep(ctx: SetupContext): Promise<HubState> {
	const { options: o, state: s, exec, log } = ctx;
	if (s.github_app_id !== undefined && s.steps_done.includes("github_app")) {
		log(`GitHub App already registered: ${s.github_app_html_url ?? ""}`);
		return s;
	}
	if (s.github_app_id !== undefined && s.github_app_secrets_stored) return redeployWithApp(ctx, s);
	if (s.github_app_id !== undefined) {
		throw new SetupError(
			"github_app_incomplete",
			`GitHub App ${s.github_app_id} (${s.github_app_html_url ?? "unknown URL"}) was created by an earlier run that did not store its credentials`,
		);
	}
	const baseUrl = s.base_url;
	if (!baseUrl) throw new Error("the setup state has no hub URL; the deploy step must run first");
	const state = randomBytes(16).toString("hex");
	const action = githubNewAppUrl({ baseUrl, name: s.name ?? "zeroci", ...(o.org ? { org: o.org } : {}), ...(o.githubBase ? { githubBase: o.githubBase } : {}) }, state);
	const manifest = renderGithubManifest(baseUrl, s.name ?? "zeroci");
	const openBrowser = o.openBrowser ?? (async () => {});
	const pending = await awaitManifestCode({
		state,
		// GitHub sends the browser back to this CLI, not the hub, with the code.
		page: (origin) => manifestFormHtml(action, { ...manifest, redirect_url: `${origin}${CALLBACK_PATH}` }, state),
		onListening: async (origin) => {
			log(`Open ${origin}/ in your browser to create the GitHub App`);
			await openBrowser(`${origin}/`);
		},
	});
	await pending.close();

	const conv = await convertManifestCode(pending.code, o.fetchFn, o.githubApiBase);
	let next: HubState = { ...s, github_app_id: conv.id, github_app_slug: conv.slug, github_app_html_url: conv.html_url, github_app_secrets_stored: false };
	await saveState(o.dir, next);
	const pem = pkcs8Pem(conv.pem);
	await verifyGithubApp(conv, o.fetchFn, o.githubApiBase);
	const secrets: [string, string][] = [
		["GITHUB_APP_ID", String(conv.id)],
		["GITHUB_APP_PRIVATE_KEY", pem],
		["GITHUB_WEBHOOK_SECRET", conv.webhook_secret],
		["GITHUB_CLIENT_ID", conv.client_id],
		["GITHUB_CLIENT_SECRET", conv.client_secret],
	];
	for (const [name, value] of secrets) await putSecret(exec, o.dir, name, value);
	next = { ...next, github_app_secrets_stored: true };
	await saveState(o.dir, next);
	return redeployWithApp(ctx, next);
}

/** Redeploys with the registered app's slug, marks the step done and prints the install link. */
async function redeployWithApp(ctx: SetupContext, s: HubState): Promise<HubState> {
	const { options: o, log } = ctx;
	let next = await deployWorker(o, await renderConfig(o, s));
	next = { ...next, steps_done: [...next.steps_done, "github_app"] };
	await saveState(o.dir, next);
	log(`Install the app: https://github.com/apps/${next.github_app_slug ?? ""}/installations/new`);
	return next;
}
