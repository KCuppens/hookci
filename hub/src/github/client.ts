import type { Env } from "../env";
import { HubError } from "../errors";
import { defaultFetcher, type Fetcher } from "../http";
import { appJwt } from "./jwt";
import { withRetry } from "./retry";
import type { AccessToken, AccessTokenRequest, InstallationPermissions } from "./types";

const API_ORIGIN = "https://api.github.com";

/** A GitHub answer other than 2xx (or 304 to a conditional request), after retries. */
export class GitHubApiError extends HubError {
	constructor(
		readonly githubStatus: number,
		message: string,
	) {
		super("github_error", 502, message);
	}
}

/** link is the raw Link header, present on paginated responses. */
export type GitHubResponse<T> = { status: number; data: T; etag?: string; link?: string; notModified: false };
export type GitHubNotModified = { status: 304; data: undefined; etag?: string; notModified: true };

export interface GitHubRequester {
	request<T>(method: string, path: string, body?: unknown): Promise<GitHubResponse<T>>;
	/** With etag set, sends If-None-Match and resolves notModified on 304. */
	request<T>(
		method: string,
		path: string,
		body: unknown,
		opts: { etag?: string },
	): Promise<GitHubResponse<T> | GitHubNotModified>;
	/** The raw content of path in repo (owner/name) at ref; null when either does not exist. */
	getRepoFileAtRef(repo: string, path: string, ref: string): Promise<string | null>;
}

async function errorMessage(res: Response): Promise<string> {
	const text = await res.text();
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && "message" in parsed && typeof parsed.message === "string") {
			return parsed.message;
		}
	} catch {
		// Not JSON; fall through to the raw text.
	}
	return text.slice(0, 200);
}

class Requester implements GitHubRequester {
	constructor(
		private readonly authorization: string,
		private readonly fetcher: Fetcher,
		private readonly now: () => number,
	) {}

	request<T>(method: string, path: string, body?: unknown): Promise<GitHubResponse<T>>;
	request<T>(
		method: string,
		path: string,
		body: unknown,
		opts: { etag?: string },
	): Promise<GitHubResponse<T> | GitHubNotModified>;
	async request<T>(
		method: string,
		path: string,
		body?: unknown,
		opts: { etag?: string } = {},
	): Promise<GitHubResponse<T> | GitHubNotModified> {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "hookci-hub",
			Authorization: this.authorization,
		};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (opts.etag !== undefined) headers["If-None-Match"] = opts.etag;
		const payload = body === undefined ? undefined : JSON.stringify(body);

		const res = await withRetry(() => this.fetcher(`${API_ORIGIN}${path}`, { method, headers, body: payload }), {
			now: this.now,
		});
		const etag = res.headers.get("etag") ?? undefined;
		if (res.status === 304 && opts.etag !== undefined) {
			return { status: 304, data: undefined, etag, notModified: true };
		}
		if (!res.ok) {
			throw new GitHubApiError(res.status, `GitHub ${method} ${path}: ${res.status} ${await errorMessage(res)}`);
		}
		const text = await res.text();
		return { status: res.status, data: JSON.parse(text || "null"), etag, link: res.headers.get("link") ?? undefined, notModified: false };
	}

	async getRepoFileAtRef(repo: string, path: string, ref: string): Promise<string | null> {
		const url = `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
		const headers = { Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "hookci-hub", Authorization: this.authorization };
		const res = await withRetry(() => this.fetcher(`${API_ORIGIN}${url}`, { method: "GET", headers }), { now: this.now });
		if (res.status === 404) return null;
		if (!res.ok) throw new GitHubApiError(res.status, `GitHub GET ${url}: ${res.status} ${await errorMessage(res)}`);
		return res.text();
	}
}

type CachedToken = { token: string; expiresAt: number };

/** Installation tokens live 60 minutes; one is reused until 5 minutes before expiry. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;

const installationTokens = new Map<string, CachedToken>();

/** Drops every cached token of the installation, for example on uninstall or suspend. */
export function invalidateInstallation(installationId: number): void {
	const prefix = `${installationId}|`;
	for (const key of installationTokens.keys()) {
		if (key.startsWith(prefix)) installationTokens.delete(key);
	}
}

export class GitHubClient {
	constructor(
		private readonly env: Env,
		private readonly fetcher: Fetcher = defaultFetcher,
		private readonly now: () => number = () => Date.now(),
	) {}

	/** Authenticated as the app itself (JWT), for /app endpoints. */
	async app(): Promise<GitHubRequester> {
		const jwt = await appJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY, this.now());
		return new Requester(`Bearer ${jwt}`, this.fetcher, this.now);
	}

	/**
	 * Authenticated with an installation token narrowed to repositoryIds and
	 * permissions when given. Tokens are cached per installation, repository
	 * set and permission set.
	 */
	async installation(
		installationId: number,
		opts: { repositoryIds?: number[]; permissions?: InstallationPermissions } = {},
	): Promise<GitHubRequester> {
		const repositoryIds = [...(opts.repositoryIds ?? [])].sort((a, b) => a - b);
		const permissions = Object.entries(opts.permissions ?? {})
			.map(([name, level]) => `${name}:${level}`)
			.sort();
		const key = `${installationId}|${repositoryIds.join(",")}|${permissions.join(",")}`;
		const now = this.now();
		const cached = installationTokens.get(key);
		if (cached && cached.expiresAt - now > TOKEN_REUSE_MARGIN_MS) {
			return new Requester(`Bearer ${cached.token}`, this.fetcher, this.now);
		}

		const body: AccessTokenRequest = {};
		if (repositoryIds.length > 0) body.repository_ids = repositoryIds;
		if (permissions.length > 0) body.permissions = opts.permissions;
		const minted = await this.mintToken(installationId, body);
		for (const [k, v] of installationTokens) {
			if (v.expiresAt - now <= TOKEN_REUSE_MARGIN_MS) installationTokens.delete(k);
		}
		installationTokens.set(key, minted);
		return new Requester(`Bearer ${minted.token}`, this.fetcher, this.now);
	}

	/** Authenticated with a user-to-server token. */
	user(userToken: string): GitHubRequester {
		return new Requester(`Bearer ${userToken}`, this.fetcher, this.now);
	}

	/** Authenticated as the app's OAuth client (Basic client id and secret), for /applications/{client_id} endpoints. */
	oauthApp(): GitHubRequester {
		return new Requester(`Basic ${btoa(`${this.env.GITHUB_CLIENT_ID}:${this.env.GITHUB_CLIENT_SECRET}`)}`, this.fetcher, this.now);
	}

	/**
	 * A fresh contents:read token for one repository, handed to the agent for
	 * a single checkout. Never cached: every run gets its own token.
	 * exp is unix seconds.
	 */
	async mintFetchToken(installationId: number, repoId: number): Promise<{ token: string; exp: number }> {
		const { token, expiresAt } = await this.mintToken(installationId, {
			repository_ids: [repoId],
			permissions: { contents: "read" },
		});
		return { token, exp: Math.floor(expiresAt / 1000) };
	}

	private async mintToken(installationId: number, body: AccessTokenRequest): Promise<CachedToken> {
		const app = await this.app();
		const res = await app.request<AccessToken>("POST", `/app/installations/${installationId}/access_tokens`, body);
		return { token: res.data.token, expiresAt: Date.parse(res.data.expires_at) };
	}
}
