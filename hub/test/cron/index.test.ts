import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCron } from "../../src/cron";
import { bind } from "../../src/db/bindings";
import { upsertInstallation } from "../../src/db/installations";
import { upsertRepos } from "../../src/db/repos";
import { tenantDb } from "../../src/db/tenant";
import type { Env } from "../../src/env";
import { clearTables } from "../db/helpers";
import { createFakeGitHub, serveBranchHeads, serveInstallationTokens, serveRepoFiles } from "../fakes/github";
import type { FakeService } from "../fakes/http";
import { generateAppKey } from "../github/helpers";

const NOW = 1_767_225_600_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const AGENT = "01hzagentaaaaaaaaaaaaaaaaa";

let gh: FakeService;
let triggeredRepos: number[];
let testEnv: Env;

beforeEach(async () => {
  await clearTables();
  gh = createFakeGitHub();
  serveRepoFiles(gh, {});
  triggeredRepos = [];
  const agents: Pick<DurableObjectNamespace, "idFromName" | "get"> = {
    idFromName: (name) => ({ name, toString: () => name, equals: (other) => other.toString() === name }),
    get: () =>
      ({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (new Request(input, init).method === "GET") return new Response(null, { status: 200 });
          triggeredRepos.push((await new Request(input, init).json<{ repoId: number }>()).repoId);
          return new Response(null, { status: 202 });
        },
      }) as unknown as DurableObjectStub,
  };
  testEnv = {
    ...env,
    AGENT_DO: agents as unknown as Env["AGENT_DO"],
    __TEST_FETCHER: gh.fetcher,
    GITHUB_APP_PRIVATE_KEY: (await generateAppKey()).pem,
    __TEST_CLOCK: { now: () => NOW },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCron", () => {
  it("runs reconcile and purge after redeliver throws, and reports only the redeliver failure", async () => {
    gh.respond("GET", "/app/hook/deliveries", () => Response.json({ message: "Bad credentials" }, { status: 401 }));
    serveInstallationTokens(gh, NOW);
    serveBranchHeads(gh, { "acme/api": { sha: "sha-missed", committedAt: NOW - 30 * MINUTE } });
    await upsertInstallation(env.DB, { id: 42, account_login: "acme", account_type: "Organization", account_id: 42 * 10, created_at: NOW - 30 * DAY });
    const t = tenantDb(env.DB, 42);
    await upsertRepos(t, [{ repo_id: 7, full_name: "acme/api", default_branch: "main" }]);
    await bind(t, 7, "checks", AGENT);
    await env.DB.prepare(
      "INSERT INTO deliveries (delivery_id, received_at, expires_at, event, installation_id, status) VALUES ('old', ?1, ?1, 'push', 42, 'processed')",
    )
      .bind(NOW - 8 * DAY)
      .run();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runCron(testEnv, "*/5 * * * *");

    expect(triggeredRepos).toEqual([7]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries").first()).toEqual({ n: 0 });
    expect(errors.mock.calls.map((args) => JSON.parse(String(args[0])))).toEqual([
      expect.objectContaining({ task: "redeliver", cron: "*/5 * * * *", error: expect.objectContaining({ code: "github_error" }) }),
    ]);
    const checked = await env.DB.prepare("SELECT component, checks_ok, checks_total FROM status_checks ORDER BY component").all();
    expect(checked.results).toEqual([
      { component: "agents", checks_ok: 1, checks_total: 1 },
      { component: "api", checks_ok: 1, checks_total: 1 },
      { component: "logs", checks_ok: 1, checks_total: 1 },
    ]);
  });
});
