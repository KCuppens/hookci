import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { exchangeCode } from "../../src/github/oauth";
import { createFakeGitHub } from "../fakes/github";

describe("exchangeCode", () => {
  it("posts the app credentials and code as JSON and returns the user token", async () => {
    const gh = createFakeGitHub();
    let accept: string | null = null;
    gh.respond("POST", "/login/oauth/access_token", ({ headers }) => {
      accept = headers.get("accept");
      return Response.json({ access_token: "ghu_1", refresh_token: "ghr_1", expires_in: 28800, token_type: "bearer" });
    });

    const token = await exchangeCode(env, gh.fetcher, "code-1");

    expect(token).toEqual({ access_token: "ghu_1", refresh_token: "ghr_1", expires_in: 28800 });
    expect(gh.calls).toEqual([
      {
        method: "POST",
        url: "https://github.com/login/oauth/access_token",
        body: { client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: "code-1" },
      },
    ]);
    expect(accept).toBe("application/json");
  });

  it("throws github_oauth_failed when GitHub answers 200 with an error", async () => {
    const gh = createFakeGitHub();
    gh.respond("POST", "/login/oauth/access_token", () =>
      Response.json({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }),
    );

    await expect(exchangeCode(env, gh.fetcher, "stale")).rejects.toMatchObject({
      code: "github_oauth_failed",
      status: 502,
    });
  });
});
