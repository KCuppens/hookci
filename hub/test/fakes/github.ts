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
