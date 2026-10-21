import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getCollaboratorPermission, getCommit, listInstallationRepos } from "../../src/github/api";
import { GitHubClient } from "../../src/github/client";
import { createFakeGitHub } from "../fakes/github";

function setup() {
  const gh = createFakeGitHub();
  return { gh, requester: new GitHubClient(env, gh.fetcher).user("ghs_token") };
}

describe("getCollaboratorPermission", () => {
  it("maps role_name maintain to maintain", async () => {
    const { gh, requester } = setup();
    gh.respond("GET", "/repos/acme/app/collaborators/octo/permission", () =>
      Response.json({ permission: "write", role_name: "maintain" }),
    );

    expect(await getCollaboratorPermission(requester, "acme", "app", "octo")).toBe("maintain");
  });

  it("maps a custom organization role to its base permission", async () => {
    const { gh, requester } = setup();
    gh.respond("GET", "/repos/acme/app/collaborators/octo/permission", () =>
      Response.json({ permission: "read", role_name: "security-auditor" }),
    );

    expect(await getCollaboratorPermission(requester, "acme", "app", "octo")).toBe("read");
  });

  it("maps a 404 to none", async () => {
    const { requester } = setup();

    expect(await getCollaboratorPermission(requester, "acme", "app", "stranger")).toBe("none");
  });

  it("rethrows other GitHub errors", async () => {
    const { gh, requester } = setup();
    gh.respond("GET", "/repos/acme/app/collaborators/octo/permission", () =>
      Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
    );

    await expect(getCollaboratorPermission(requester, "acme", "app", "octo")).rejects.toMatchObject({
      code: "github_error",
      githubStatus: 403,
    });
  });
});

describe("listInstallationRepos", () => {
  it("follows pages of 100 until a short page", async () => {
    const { gh, requester } = setup();
    const repos = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, full_name: `acme/r${i + 1}` }));
    gh.respond("GET", "/installation/repositories", ({ url }) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json({ total_count: 150, repositories: repos.slice((page - 1) * 100, page * 100) });
    });

    const listed = await listInstallationRepos(requester);

    expect(listed.map((r) => r.id)).toEqual(repos.map((r) => r.id));
    expect(gh.calls.map((c) => new URL(c.url).search)).toEqual(["?per_page=100&page=1", "?per_page=100&page=2"]);
  });
});

describe("getCommit", () => {
  it("returns the author email and the first line of the message", async () => {
    const { gh, requester } = setup();
    gh.respond("GET", "/repos/acme/app/commits/abc123", () =>
      Response.json({
        sha: "abc123",
        commit: { message: "Fix the flaky test\n\nLonger body.", author: { name: "Oct", email: "oct@example.com", date: "" } },
        author: { id: 9, login: "octo" },
      }),
    );

    expect(await getCommit(requester, "acme", "app", "abc123")).toEqual({
      sha: "abc123",
      authorEmail: "oct@example.com",
      authorLogin: "octo",
      title: "Fix the flaky test",
    });
  });
});
