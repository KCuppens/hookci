import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileDefaultBranches } from "../../src/cron/reconcile";
import { bind } from "../../src/db/bindings";
import { getCronState } from "../../src/db/cron-state";
import { markDeleted, markSuspended, upsertInstallation } from "../../src/db/installations";
import { upsertRepos } from "../../src/db/repos";
import { insertRun } from "../../src/db/runs";
import { tenantDb } from "../../src/db/tenant";
import type { Env } from "../../src/env";
import { ulid } from "../../src/ulid";
import type { TriggerRequest } from "../../src/webhook/route";
import { clearTables } from "../db/helpers";
import { createFakeGitHub, type FakeBranchHead, serveBranchHeads, serveInstallationTokens, serveRepoFiles } from "../fakes/github";
import type { FakeService } from "../fakes/http";
import { generateAppKey } from "../github/helpers";

const NOW = 1_767_225_600_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const INSTALLATION = 42;
const AGENT = "01hzagentaaaaaaaaaaaaaaaaa";

type DoCall = { agentId: string; body: TriggerRequest };

let pem: string;
let gh: FakeService;
let doCalls: DoCall[];
let testEnv: Env;

/** AgentDO namespace whose stubs record each trigger and accept it. */
function fakeAgentDOs(): Env["AGENT_DO"] {
  const namespace: Pick<DurableObjectNamespace, "idFromName" | "get"> = {
    idFromName: (name) => ({ name, toString: () => name, equals: (other) => other.toString() === name }),
    get: (id) =>
      ({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          doCalls.push({ agentId: id.toString(), body: await new Request(input, init).json<TriggerRequest>() });
          return new Response(null, { status: 202 });
        },
      }) as unknown as DurableObjectStub,
  };
  return namespace as unknown as Env["AGENT_DO"];
}

async function addInstallation(id: number): Promise<void> {
  await upsertInstallation(env.DB, { id, account_login: `org${id}`, account_type: "Organization", account_id: id * 10, created_at: NOW - 30 * DAY });
}

/** Adds repos named org<installation>/r<id> on main, each bound to AGENT for checks. */
async function addRepos(installationId: number, repoIds: readonly number[]): Promise<void> {
  const t = tenantDb(env.DB, installationId);
  await upsertRepos(
    t,
    repoIds.map((id) => ({ repo_id: id, full_name: `org${installationId}/r${id}`, default_branch: "main" })),
  );
  for (const id of repoIds) await bind(t, id, "checks", AGENT);
}

/** Repo ids whose branch GitHub was asked for, in order. */
function branchLookups(): number[] {
  return gh.calls.flatMap((c) => {
    const m = /^\/repos\/[^/]+\/r(\d+)\/branches\/main$/.exec(new URL(c.url).pathname);
    return c.method === "GET" && m ? [Number(m[1])] : [];
  });
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

beforeAll(async () => {
  pem = (await generateAppKey()).pem;
});

beforeEach(async () => {
  await clearTables();
  gh = createFakeGitHub();
  doCalls = [];
  serveInstallationTokens(gh, NOW);
  serveRepoFiles(gh, {});
  testEnv = { ...env, AGENT_DO: fakeAgentDOs(), __TEST_FETCHER: gh.fetcher, GITHUB_APP_PRIVATE_KEY: pem, __TEST_CLOCK: { now: () => NOW } };
  await addInstallation(INSTALLATION);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconcileDefaultBranches", () => {
  it("synthesizes a push only for a head between 10 minutes and a day old without a run", async () => {
    await addRepos(INSTALLATION, [1, 2, 3, 4]);
    await insertRun(tenantDb(env.DB, INSTALLATION), {
      run_id: "run-built",
      repo_id: 4,
      sha: "sha-built",
      ref: "refs/heads/main",
      event: "push",
      pr_number: null,
      env: null,
      attempt: 1,
      trigger_id: ulid(NOW - 25 * MINUTE),
      agent_id: AGENT,
      state: "success",
      reason: null,
      author_login: "octocat",
      commit_title: "Fix the build",
      started_at: NOW - 25 * MINUTE,
      finished_at: NOW - 20 * MINUTE,
      duration_ms: 5 * MINUTE,
      log_key: null,
    });
    const heads: Record<string, FakeBranchHead> = {
      "org42/r1": { sha: "sha-missed", committedAt: NOW - 30 * MINUTE, message: "Ship the parser\n\nDetails." },
      "org42/r2": { sha: "sha-young", committedAt: NOW - 5 * MINUTE },
      "org42/r3": { sha: "sha-stale", committedAt: NOW - 2 * DAY },
      "org42/r4": { sha: "sha-built", committedAt: NOW - 30 * MINUTE },
    };
    serveBranchHeads(gh, heads);
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await reconcileDefaultBranches(testEnv, NOW)).toEqual({ checked: 4, synthesized: 1 });
    expect(doCalls).toEqual([
      {
        agentId: AGENT,
        body: {
          installationId: INSTALLATION,
          repoId: 1,
          repo: "org42/r1",
          sha: "sha-missed",
          ref: "refs/heads/main",
          event: "push",
          authorLogin: "octocat",
          authorEmail: "octo@example.com",
          commitTitle: "Ship the parser",
          defaultBranch: "main",
          target: "checks",
          trust: "trusted",
        },
      },
    ]);
    const events = logs.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>).filter((l) => l.event === "reconcile_synthesized");
    expect(events).toEqual([expect.objectContaining({ installation_id: INSTALLATION, repo_id: 1, sha: "sha-missed", outcome: "dispatched" })]);
  });

  it.each([
    ["its config does not want", "checks:\n  on:\n    push:\n      branches: [release]\n"],
    ["without a .hookci.yml", null],
  ])("neither counts nor logs a head %s", async (_, config) => {
    await addRepos(INSTALLATION, [1]);
    serveBranchHeads(gh, { "org42/r1": { sha: "sha-1", committedAt: NOW - 30 * MINUTE } });
    serveRepoFiles(gh, { "org42/r1@sha-1:.hookci.yml": config });
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await reconcileDefaultBranches(testEnv, NOW)).toEqual({ checked: 1, synthesized: 0 });
    expect(doCalls).toEqual([]);
    expect(logs.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>).filter((l) => l.event === "reconcile_synthesized")).toEqual([]);
  });

  it("reports a repo whose branch lookup fails and goes on with the next", async () => {
    await addRepos(INSTALLATION, [1, 2]);
    serveBranchHeads(gh, { "org42/r2": { sha: "sha-2", committedAt: NOW - 30 * MINUTE } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await reconcileDefaultBranches(testEnv, NOW)).toEqual({ checked: 2, synthesized: 1 });
    expect(doCalls.map((c) => c.body.repoId)).toEqual([2]);
    expect(errors.mock.calls.map((args) => JSON.parse(String(args[0])))).toEqual([
      expect.objectContaining({ task: "reconcile", installation_id: INSTALLATION, repo_id: 1 }),
    ]);
  });

  it("covers 120 repos in three ticks of 50 and then wraps to the first", async () => {
    const ids = range(1, 120);
    await addRepos(INSTALLATION, ids);
    serveBranchHeads(gh, Object.fromEntries(ids.map((id) => [`org42/r${id}`, { sha: `sha-${id}`, committedAt: NOW - 2 * DAY }])));

    const ticks: number[][] = [];
    for (let tick = 0; tick < 4; tick++) {
      gh.calls.length = 0;
      const { checked } = await reconcileDefaultBranches(testEnv, NOW + tick * 5 * MINUTE, 50);
      ticks.push(branchLookups());
      expect(checked).toBe(ticks[tick]!.length);
    }

    expect(ticks.slice(0, 3)).toEqual([range(1, 50), range(51, 100), range(101, 120)]);
    expect(ticks.slice(0, 3).flat()).toEqual(ids);
    expect(ticks[3]).toEqual(range(1, 50));
    expect(JSON.parse((await getCronState(env.DB, "reconcile_cursor"))!)).toEqual({ repoId: 50, installationId: INSTALLATION });
    expect(doCalls).toEqual([]);
  });

  it("starts over within the tick when the previous one ended exactly on the last repo", async () => {
    const ids = range(1, 100);
    await addRepos(INSTALLATION, ids);
    serveBranchHeads(gh, Object.fromEntries(ids.map((id) => [`org42/r${id}`, { sha: `sha-${id}`, committedAt: NOW - 2 * DAY }])));

    const ticks: number[][] = [];
    for (let tick = 0; tick < 3; tick++) {
      gh.calls.length = 0;
      await reconcileDefaultBranches(testEnv, NOW, 50);
      ticks.push(branchLookups());
    }
    expect(ticks).toEqual([range(1, 50), range(51, 100), range(1, 50)]);
  });

  it("skips repos of suspended and deleted installations", async () => {
    await addRepos(INSTALLATION, [1]);
    await addInstallation(43);
    await addRepos(43, [2]);
    await markSuspended(env.DB, 43, NOW - DAY);
    await addInstallation(44);
    await addRepos(44, [3]);
    await markDeleted(env.DB, 44, NOW - DAY, NOW + 2 * DAY);
    serveBranchHeads(gh, {
      "org42/r1": { sha: "sha-1", committedAt: NOW - 30 * MINUTE },
      "org43/r2": { sha: "sha-2", committedAt: NOW - 30 * MINUTE },
      "org44/r3": { sha: "sha-3", committedAt: NOW - 30 * MINUTE },
    });

    expect(await reconcileDefaultBranches(testEnv, NOW)).toEqual({ checked: 1, synthesized: 1 });
    expect(branchLookups()).toEqual([1]);
    expect(doCalls.map((c) => c.body.installationId)).toEqual([INSTALLATION]);
    expect(gh.calls.filter((c) => /\/installations\/(43|44)\//.test(c.url))).toEqual([]);
  });
});
