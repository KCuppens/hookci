import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FLUSH_INTERVAL_MS } from "../../src/checks/coalesce";
import { getCheckRun } from "../../src/db/check-runs";
import { upsertInstallation } from "../../src/db/installations";
import { tenantDb } from "../../src/db/tenant";
import { AGGREGATE_CHECK, type ChecksSink, checksSinkFactory } from "../../src/sinks/checks";
import type { Annotation, JobView, RunView } from "../../src/sinks/types";
import { S } from "../../src/strings";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { type Agent, seedAgent } from "../do/agent-socket";
import { createFakeGitHub } from "../fakes/github";
import { generateAppKey } from "../github/helpers";

const INSTALLATION = 42;
const REPO = 1001;
const SHA = "1".repeat(40);

const gh = createFakeGitHub();

function runView(over: Partial<RunView> = {}): RunView {
  return {
    installationId: INSTALLATION,
    repoId: REPO,
    repo: "acme/widgets",
    triggerId: "trg_1",
    runId: "run_1",
    sha: SHA,
    shortSha: SHA.slice(0, 7),
    event: "pull_request",
    prNumber: 7,
    target: "checks",
    state: "running",
    commitTitle: "Add widget sizing",
    authorLogin: "alice",
    jobs: [],
    ...over,
  };
}

const PLANNED: JobView[] = [
  { name: "lint", state: "queued" },
  { name: "test", state: "queued" },
  { name: "_config", state: "success" },
];

/** The fields of a JSON object; {} for anything else. */
function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : {};
}

/** The check run requests the fake GitHub received, in order, with the fields the tests look at. */
function checkCalls(): Record<string, unknown>[] {
  return gh.calls.flatMap((call) => {
    const match = /\/check-runs(?:\/(\d+))?$/.exec(new URL(call.url).pathname);
    if (!match) return [];
    const body = fields(call.body);
    const output = fields(body.output);
    const seen: Record<string, unknown> = {
      method: call.method,
      id: match[1] ? Number(match[1]) : undefined,
      name: body.name,
      status: body.status,
      conclusion: body.conclusion,
      title: output.title,
      summary: output.summary,
      annotations: Array.isArray(output.annotations) ? output.annotations.length : undefined,
      external_id: body.external_id,
    };
    return [Object.fromEntries(Object.entries(seen).filter(([, v]) => v !== undefined))];
  });
}

/** Runs fn with the ChecksSink an AgentDO's fan-out builds: coalesced, with the DO's storage and clock. */
async function inAgent(agent: Agent, fn: (sink: ChecksSink) => Promise<void>): Promise<void> {
  await runInDurableObject(agent.stub, (dob) =>
    fn(checksSinkFactory(dob.bindings, INSTALLATION, { storage: dob.state.storage, now: () => dob.clock.now() })),
  );
}

describe("ChecksSink", () => {
  let pem: string;
  let nextId: number;
  let gone: Set<number>;
  let refuseReopen: boolean;
  const saved = { fetcher: env.__TEST_FETCHER, key: env.GITHUB_APP_PRIVATE_KEY };

  beforeAll(async () => {
    pem = (await generateAppKey()).pem;
  });

  beforeEach(async () => {
    await clearTables();
    await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", account_id: INSTALLATION * 10, created_at: 1 });
    nextId = 100;
    gone = new Set();
    refuseReopen = false;
    env.__TEST_FETCHER = gh.fetcher;
    env.GITHUB_APP_PRIVATE_KEY = pem;
    gh.respond("POST", "/app/installations/:id/access_tokens", () =>
      Response.json({ token: "ghs_checks", expires_at: "2030-01-01T00:00:00Z" }, { status: 201 }),
    );
    gh.respond("POST", "/repos/:owner/:repo/check-runs", (req) => Response.json({ id: nextId++, ...fields(req.body) }, { status: 201 }));
    gh.respond("PATCH", "/repos/:owner/:repo/check-runs/:id", (req) => {
      const id = Number(req.params.id);
      if (gone.has(id)) return Response.json({ message: "Not Found" }, { status: 404 });
      if (refuseReopen && fields(req.body).status !== "completed") {
        return Response.json({ message: "Validation Failed" }, { status: 422 });
      }
      return Response.json({ id, ...fields(req.body) });
    });
  });

  afterEach(() => {
    env.__TEST_FETCHER = saved.fetcher;
    env.GITHUB_APP_PRIVATE_KEY = saved.key;
  });

  it("job_planned creates the aggregate, a queued check per job and a neutral config check, once", async () => {
    const agent = await seedAgent(INSTALLATION);
    await inAgent(agent, async (sink) => {
      await sink.onJobPlanned(runView({ jobs: PLANNED }));
      await sink.onJobPlanned(runView({ jobs: PLANNED }));
    });
    expect(checkCalls()).toEqual([
      expect.objectContaining({ method: "POST", name: "zeroci", status: "in_progress", external_id: "run_1" }),
      expect.objectContaining({ method: "POST", name: "zeroci/lint", status: "queued" }),
      expect.objectContaining({ method: "POST", name: "zeroci/test", status: "queued" }),
      expect.objectContaining({ method: "POST", name: "zeroci/config", status: "completed", conclusion: "neutral" }),
    ]);
    expect(await getCheckRun(tenantDb(env.DB, INSTALLATION), REPO, SHA, "zeroci/test")).toBe(102);
  });

  it("20 job updates within a second make at most 2 update calls, the completed one at once", async () => {
    const agent = await seedAgent(INSTALLATION);
    await inAgent(agent, async (sink) => {
      const run = runView({ jobs: PLANNED });
      await sink.onJobPlanned(run);
      gh.calls.length = 0;
      for (let i = 0; i < 19; i++) {
        await sink.onJobUpdate(run, { name: "test", state: "running", step: `step ${i}`, stepIndex: i, stepsTotal: 20 });
        testClock.advance(50);
      }
      await sink.onJobUpdate(run, { name: "test", state: "success", durationMs: 950 });
    });
    const updates = checkCalls();
    expect(updates.length).toBeLessThanOrEqual(2);
    expect(updates.every((u) => u.method === "PATCH" && u.id === 102)).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "completed", conclusion: "success", title: "Passed" });

    testClock.advance(FLUSH_INTERVAL_MS);
    await runDurableObjectAlarm(agent.stub);
    expect(checkCalls()).toEqual(updates);
  });

  it("the alarm sends the latest held-back update", async () => {
    const agent = await seedAgent(INSTALLATION);
    await inAgent(agent, async (sink) => {
      const run = runView({ jobs: PLANNED });
      await sink.onJobPlanned(run);
      gh.calls.length = 0;
      await sink.onJobUpdate(run, { name: "test", state: "running", step: "compile", stepIndex: 0, stepsTotal: 2 });
      await sink.onJobUpdate(run, { name: "test", state: "running", step: "unit", stepIndex: 1, stepsTotal: 2 });
    });
    expect(checkCalls().map((c) => c.title)).toEqual(["Running: compile"]);
    testClock.advance(FLUSH_INTERVAL_MS);
    expect(await runDurableObjectAlarm(agent.stub)).toBe(true);
    expect(checkCalls().map((c) => c.title)).toEqual(["Running: compile", "Running: unit"]);
  });

  it("120 annotations go out as 3 updates of at most 50, each with the title", async () => {
    const annotations: Annotation[] = Array.from({ length: 120 }, (_, i) => ({
      path: "src/a.ts",
      start_line: i + 1,
      end_line: i + 1,
      level: "failure",
      message: `error ${i}`,
    }));
    const agent = await seedAgent(INSTALLATION);
    await inAgent(agent, async (sink) => {
      const run = runView({ jobs: [{ name: "lint", state: "failed", durationMs: 3000 }] });
      await sink.onJobPlanned(run);
      gh.calls.length = 0;
      await sink.onAnnotations(run, "lint", annotations);
    });
    const updates = checkCalls();
    expect(updates.map((u) => u.annotations)).toEqual([50, 50, 20]);
    for (const u of updates) {
      expect(u).toMatchObject({ method: "PATCH", id: 101 });
      expect(u.title).toBeTruthy();
      expect(u.summary).toBeTruthy();
    }
  });

  it("caps annotations at 500 per job and notes the truncation", async () => {
    const annotations: Annotation[] = Array.from({ length: 300 }, (_, i) => ({
      path: "src/a.ts",
      start_line: i + 1,
      end_line: i + 1,
      level: "warning",
      message: `warning ${i}`,
    }));
    const agent = await seedAgent(INSTALLATION);
    await inAgent(agent, async (sink) => {
      const run = runView({ jobs: [{ name: "lint", state: "running" }] });
      await sink.onJobPlanned(run);
      gh.calls.length = 0;
      await sink.onAnnotations(run, "lint", annotations);
      await sink.onAnnotations(run, "lint", annotations);
      testClock.advance(FLUSH_INTERVAL_MS);
      await sink.onJobUpdate(run, { name: "lint", state: "success", durationMs: 1000 });
    });
    const updates = checkCalls();
    expect(updates.reduce((n, u) => n + (typeof u.annotations === "number" ? u.annotations : 0), 0)).toBe(500);
    const note = S.checks.annotationsTruncated(500);
    expect(updates.at(-2)?.summary).toContain(note);
    expect(updates.at(-1)).toMatchObject({ status: "completed" });
    expect(updates.at(-1)?.annotations).toBeUndefined();
    expect(updates.at(-1)?.summary).toContain(note);
  });

  it("config annotations go to the config check", async () => {
    const agent = await seedAgent(INSTALLATION);
    await inAgent(agent, async (sink) => {
      const run = runView({ jobs: [{ name: "_config", state: "failed", reason: "jobs.test: unknown key" }] });
      await sink.onJobPlanned(run);
      await sink.onAnnotations(run, "_config", [{ path: ".zeroci.yml", start_line: 4, end_line: 4, level: "failure", message: "unknown key" }]);
    });
    expect(checkCalls().at(-1)).toMatchObject({ method: "PATCH", id: 101, conclusion: "neutral", title: S.checks.configInvalid, annotations: 1 });
  });

  it("an agent_offline run's aggregate needs action, reopens when the run starts and passes at the end", async () => {
    const agent = await seedAgent(INSTALLATION);
    await inAgent(agent, async (sink) => {
      await sink.onRunUpdate(runView({ state: "pending", reason: "agent_offline" }));
      testClock.advance(600_000);
      await sink.onRunUpdate(runView({ state: "running" }));
      await sink.onRunUpdate(runView({ state: "success", jobs: [{ name: "test", state: "success", durationMs: 1000 }] }));
    });
    expect(checkCalls()).toEqual([
      expect.objectContaining({ method: "POST", name: AGGREGATE_CHECK, status: "completed", conclusion: "action_required", title: S.checks.agent_offline.title }),
      expect.objectContaining({ method: "PATCH", id: 100, status: "in_progress" }),
      expect.objectContaining({ method: "PATCH", id: 100, status: "completed", conclusion: "success" }),
    ]);
  });

  it("recreates the aggregate when GitHub refuses to reopen it", async () => {
    refuseReopen = true;
    const agent = await seedAgent(INSTALLATION);
    await inAgent(agent, async (sink) => {
      await sink.onRunUpdate(runView({ state: "pending", reason: "fork_gated" }));
      testClock.advance(600_000);
      await sink.onRunUpdate(runView({ state: "running" }));
    });
    expect(checkCalls().slice(1)).toEqual([
      expect.objectContaining({ method: "PATCH", id: 100, status: "in_progress" }),
      expect.objectContaining({ method: "POST", name: AGGREGATE_CHECK, status: "in_progress" }),
    ]);
    expect(await getCheckRun(tenantDb(env.DB, INSTALLATION), REPO, SHA, AGGREGATE_CHECK)).toBe(101);
  });

  it("a superseded run's aggregate concludes cancelled", async () => {
    await checksSinkFactory(env, INSTALLATION).onRunUpdate(runView({ state: "superseded" }));
    expect(checkCalls()).toEqual([
      expect.objectContaining({ method: "POST", name: AGGREGATE_CHECK, status: "completed", conclusion: "cancelled", summary: S.checks.superseded }),
    ]);
  });

  it("without an AgentDO every update goes out at once", async () => {
    const sink = checksSinkFactory(env, INSTALLATION);
    await sink.onRunUpdate(runView({ state: "pending", reason: "no_agent" }));
    await sink.onRunUpdate(runView({ state: "pending", reason: "daily_cap" }));
    expect(checkCalls()).toEqual([
      expect.objectContaining({ method: "POST", conclusion: "action_required", title: S.checks.no_agent.title }),
      expect.objectContaining({ method: "PATCH", id: 100, conclusion: "action_required", title: S.checks.daily_cap.title }),
    ]);
  });

  it.each(["deploy:prod", "deploy:staging"])("a %s run gets no checks", async (target) => {
    const agent = await seedAgent(INSTALLATION);
    await inAgent(agent, async (sink) => {
      const run = runView({ target, jobs: PLANNED });
      await sink.onRunUpdate(run);
      await sink.onJobPlanned(run);
      await sink.onJobUpdate(run, { name: "test", state: "success" });
      await sink.onAnnotations(run, "test", [{ path: "a", start_line: 1, end_line: 1, level: "notice", message: "m" }]);
    });
    expect(gh.calls).toEqual([]);
  });

  it("a suspended installation's run makes no GitHub call", async () => {
    await checksSinkFactory(env, INSTALLATION).onRunUpdate(runView({ state: "pending", reason: "suspended" }));
    expect(gh.calls).toEqual([]);
  });

  it("a 404 on update recreates the check and stores the new id", async () => {
    const agent = await seedAgent(INSTALLATION);
    await inAgent(agent, async (sink) => {
      const run = runView({ jobs: PLANNED });
      await sink.onJobPlanned(run);
      gone.add(102);
      gh.calls.length = 0;
      await sink.onJobUpdate(run, { name: "test", state: "failed", durationMs: 4000 });
    });
    expect(checkCalls()).toEqual([
      expect.objectContaining({ method: "PATCH", id: 102 }),
      expect.objectContaining({ method: "POST", name: "zeroci/test", status: "completed", conclusion: "failure" }),
    ]);
    expect(await getCheckRun(tenantDb(env.DB, INSTALLATION), REPO, SHA, "zeroci/test")).toBe(104);
  });
});
