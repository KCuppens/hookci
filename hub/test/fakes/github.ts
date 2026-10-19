import type { HookDelivery } from "../../src/github/types";
import { createFakeService, type FakeService } from "./http";

/** Fake GitHub (api.github.com and github.com OAuth); unmatched requests get GitHub's 404 body. */
export function createFakeGitHub(): FakeService {
  return createFakeService(() =>
    Response.json(
      { message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" },
      { status: 404 },
    ),
  );
}

/**
 * Serves deliveries, given newest first, at GET /app/hook/deliveries perPage
 * at a time with GitHub's Link cursor, and answers each redelivery POST with 202.
 */
export function serveHookDeliveries(gh: FakeService, deliveries: readonly HookDelivery[], perPage = 100): void {
  gh.respond("GET", "/app/hook/deliveries", ({ url }) => {
    const start = Number(new URL(url).searchParams.get("cursor") ?? 0);
    const headers = new Headers();
    if (start + perPage < deliveries.length) {
      const next = `https://api.github.com/app/hook/deliveries?per_page=${perPage}&cursor=${start + perPage}`;
      headers.set("link", `<${next}>; rel="next", <https://api.github.com/app/hook/deliveries?per_page=${perPage}>; rel="first"`);
    }
    return Response.json(deliveries.slice(start, start + perPage), { headers });
  });
  gh.respond("POST", "/app/hook/deliveries/:id/attempts", () => Response.json({}, { status: 202 }));
}

/** Answers installation token requests for every installation with a token valid an hour past now. */
export function serveInstallationTokens(gh: FakeService, now: number): void {
  gh.respond("POST", "/app/installations/:id/access_tokens", ({ params }) =>
    Response.json({ token: `ghs_${params.id}`, expires_at: new Date(now + 3_600_000).toISOString() }, { status: 201 }),
  );
}

export type FakeBranchHead = { sha: string; committedAt: number; message?: string; login?: string };

/** Serves GET /repos/:owner/:repo/branches/:branch from heads keyed by owner/repo; other repos get 404. */
export function serveBranchHeads(gh: FakeService, heads: Record<string, FakeBranchHead>): void {
  gh.respond("GET", "/repos/:owner/:repo/branches/:branch", ({ params }) => {
    const head = heads[`${params.owner}/${params.repo}`];
    if (head === undefined) return Response.json({ message: "Branch not found" }, { status: 404 });
    const date = new Date(head.committedAt).toISOString();
    return Response.json({
      name: params.branch,
      commit: {
        sha: head.sha,
        commit: {
          message: head.message ?? "Fix the build\n\nLonger description.",
          author: { name: "Octo Cat", email: "octo@example.com", date: new Date(head.committedAt - 60_000).toISOString() },
          committer: { name: "GitHub", email: "noreply@github.com", date },
        },
        author: { id: 7, login: head.login ?? "octocat" },
      },
    });
  });
}
