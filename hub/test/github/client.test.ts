import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GitHubClient, type GitHubRequester, invalidateInstallation } from "../../src/github/client";
import { createFakeGitHub } from "../fakes/github";
import { generateAppKey } from "./helpers";

const MINUTE = 60_000;
const START = Date.UTC(2025, 0, 1);

let pem = "";
beforeAll(async () => {
  ({ pem } = await generateAppKey());
});

/**
 * A fake GitHub minting tokens valid 60 minutes from the client's clock, and
 * a /whoami route echoing the Authorization header a requester sends.
 */
function setup() {
  const gh = createFakeGitHub();
  const clock = { now: START };
  let minted = 0;
  gh.respond("POST", "/app/installations/:id/access_tokens", () => {
    minted++;
    return Response.json(
      { token: `ghs_${minted}`, expires_at: new Date(clock.now + 60 * MINUTE).toISOString() },
      { status: 201 },
    );
  });
  gh.respond("GET", "/whoami", ({ headers }) => Response.json({ auth: headers.get("authorization") }));
  const client = new GitHubClient({ ...env, GITHUB_APP_PRIVATE_KEY: pem }, gh.fetcher, () => clock.now);
  const tokenPosts = () => gh.calls.filter((c) => c.method === "POST" && c.url.endsWith("/access_tokens"));
  return { gh, clock, client, tokenPosts };
}

async function tokenOf(requester: GitHubRequester): Promise<string | null> {
  const { data } = await requester.request<{ auth: string | null }>("GET", "/whoami");
  return data.auth;
}

beforeEach(() => {
  invalidateInstallation(1);
});

describe("GitHubClient.installation token cache", () => {
  it("mints one token for two calls within 54 minutes, scoped to the sorted repository ids", async () => {
    const { clock, client, tokenPosts } = setup();

    const first = await client.installation(1, { repositoryIds: [2, 1] });
    clock.now += 54 * MINUTE;
    const second = await client.installation(1, { repositoryIds: [2, 1] });

    expect(tokenPosts()).toHaveLength(1);
    expect(tokenPosts()[0]?.url).toBe("https://api.github.com/app/installations/1/access_tokens");
    expect(tokenPosts()[0]?.body).toEqual({ repository_ids: [1, 2] });
    expect(await tokenOf(first)).toBe("Bearer ghs_1");
    expect(await tokenOf(second)).toBe("Bearer ghs_1");
  });

  it("shares one entry between repository ids [1,2] and [2,1]", async () => {
    const { client, tokenPosts } = setup();

    await client.installation(1, { repositoryIds: [1, 2] });
    const swapped = await client.installation(1, { repositoryIds: [2, 1] });

    expect(tokenPosts()).toHaveLength(1);
    expect(await tokenOf(swapped)).toBe("Bearer ghs_1");
  });

  it("mints a new token at 56 minutes, when under 5 minutes of life remain", async () => {
    const { clock, client, tokenPosts } = setup();

    await client.installation(1, { repositoryIds: [2, 1] });
    clock.now += 56 * MINUTE;
    const later = await client.installation(1, { repositoryIds: [2, 1] });

    expect(tokenPosts()).toHaveLength(2);
    expect(await tokenOf(later)).toBe("Bearer ghs_2");
  });

  it("mints a separate token for different permissions", async () => {
    const { client, tokenPosts } = setup();

    const checks = await client.installation(1, { repositoryIds: [1], permissions: { checks: "write" } });
    const contents = await client.installation(1, { repositoryIds: [1], permissions: { contents: "read" } });
    const checksAgain = await client.installation(1, { repositoryIds: [1], permissions: { checks: "write" } });

    expect(tokenPosts().map((c) => c.body)).toEqual([
      { repository_ids: [1], permissions: { checks: "write" } },
      { repository_ids: [1], permissions: { contents: "read" } },
    ]);
    expect(await tokenOf(checks)).toBe("Bearer ghs_1");
    expect(await tokenOf(contents)).toBe("Bearer ghs_2");
    expect(await tokenOf(checksAgain)).toBe("Bearer ghs_1");
  });

  it("re-mints after invalidateInstallation", async () => {
    const { client, tokenPosts } = setup();

    await client.installation(1, { repositoryIds: [1] });
    invalidateInstallation(1);
    const fresh = await client.installation(1, { repositoryIds: [1] });

    expect(tokenPosts()).toHaveLength(2);
    expect(await tokenOf(fresh)).toBe("Bearer ghs_2");
  });

  it("authenticates the token request with the app JWT", async () => {
    const { gh, client } = setup();
    let auth: string | null = null;
    gh.respond("POST", "/app/installations/:id/access_tokens", ({ headers }) => {
      auth = headers.get("authorization");
      return Response.json({ token: "ghs_x", expires_at: new Date(START + 60 * MINUTE).toISOString() });
    });

    await client.installation(1);

    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });
});

describe("GitHubClient.mintFetchToken", () => {
  it("requests a contents:read token for exactly one repository and never caches it", async () => {
    const { client, tokenPosts } = setup();

    const first = await client.mintFetchToken(1, 42);
    const second = await client.mintFetchToken(1, 42);
    const cachedPath = await client.installation(1, { repositoryIds: [42], permissions: { contents: "read" } });

    expect(tokenPosts().map((c) => c.body)).toEqual([
      { repository_ids: [42], permissions: { contents: "read" } },
      { repository_ids: [42], permissions: { contents: "read" } },
      { repository_ids: [42], permissions: { contents: "read" } },
    ]);
    expect(first).toEqual({ token: "ghs_1", exp: (START + 60 * MINUTE) / 1000 });
    expect(second.token).toBe("ghs_2");
    expect(await tokenOf(cachedPath)).toBe("Bearer ghs_3");
  });
});

describe("GitHubRequester.request", () => {
  it("sends the GitHub API headers and If-None-Match, and reports notModified on 304", async () => {
    const { gh, client } = setup();
    const seen: Headers[] = [];
    gh.respond("GET", "/repos/:owner/:repo", ({ headers }) => {
      seen.push(headers);
      if (headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      return Response.json({ id: 7 }, { headers: { etag: '"v1"' } });
    });
    const user = client.user("ghu_token");

    const fresh = await user.request<{ id: number }>("GET", "/repos/o/r", undefined, {});
    const cached = await user.request<{ id: number }>("GET", "/repos/o/r", undefined, { etag: '"v1"' });

    expect(fresh).toEqual({ status: 200, data: { id: 7 }, etag: '"v1"', notModified: false });
    expect(cached).toEqual({ status: 304, data: undefined, etag: '"v1"', notModified: true });
    expect(seen[0]?.get("if-none-match")).toBeNull();
    expect(seen[1]?.get("if-none-match")).toBe('"v1"');
    expect(seen[1]?.get("accept")).toBe("application/vnd.github+json");
    expect(seen[1]?.get("x-github-api-version")).toBe("2022-11-28");
    expect(seen[1]?.get("user-agent")).toBe("hookci-hub");
    expect(seen[1]?.get("authorization")).toBe("Bearer ghu_token");
  });

  it("throws github_error carrying GitHub's status on a non-2xx answer", async () => {
    const { client } = setup();

    await expect(client.user("ghu_token").request("GET", "/repos/o/missing")).rejects.toMatchObject({
      code: "github_error",
      status: 502,
      githubStatus: 404,
    });
  });
});
