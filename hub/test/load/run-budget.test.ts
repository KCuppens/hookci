import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex, hmacSha256 } from "../../src/crypto";
import type { SlackQueueStats } from "../../src/do/slack-outbound";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { QUOTAS } from "../../src/quotas";
import type { TriggerRequest } from "../../src/webhook/route";
import { clearTables } from "../db/helpers";
import { type Agent, type AgentSocket, connect } from "../do/agent-socket";
import { formField } from "../do/slack-queue-world";
import { createFakeGitHub, serveInstallationTokens } from "../fakes/github";
import { createFakeSlack } from "../fakes/slack";
import pushMain from "../fixtures/github/push.main.json";
import { generateAppKey } from "../github/helpers";
import { countingD1 } from "../helpers/d1-counter";
import { seedTenant, type Tenant } from "../helpers/tenants";

/** D1 rows one run of 3 jobs x 10 steps may write; may be lowered; never raised without a note why. */
export const D1_ROWS_PER_RUN_BUDGET = 90;

const JOBS = ["build", "test", "lint"] as const;
const STEPS = 10;
// The AgentDO alarm closes a socket silent for 60 s; past this, only the Slack queues run.
const AGENT_ALARM_WINDOW_MS = 30_000;

type Frame = Record<string, unknown>;
type SlackCall = { team: string; method: string; at: number };

let at = 0;
const clock = {
  now: () => at,
  advance(ms: number) {
    at += ms;
  },
};
const slack = createFakeSlack();
const gh = createFakeGitHub();
const slackCalls: SlackCall[] = [];
let lastFrameAt = 0;
// Simulated ms per tick. The waited Slack calls time out after 10 s of real
// time, so under load each tick must cover more simulated time than it costs.
let tickMs = 250;
let saved: Pick<Env, "DB" | "__TEST_CLOCK" | "__TEST_FETCHER" | "GITHUB_APP_PRIVATE_KEY">;

beforeEach(async () => {
  saved = { DB: env.DB, __TEST_CLOCK: env.__TEST_CLOCK, __TEST_FETCHER: env.__TEST_FETCHER, GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY };
  // An hour ahead of the wall clock, so no alarm fires on its own; tick() runs them.
  at = Date.now() + 3_600_000;
  lastFrameAt = at;
  tickMs = 250;
  slackCalls.length = 0;
  env.__TEST_CLOCK = clock;
  env.GITHUB_APP_PRIVATE_KEY = (await generateAppKey()).pem;
  env.__TEST_FETCHER = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname !== "slack.com") return gh.fetcher(req);
    const team = /^Bearer xoxb-(\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "(none)";
    slackCalls.push({ team, method: url.pathname.replace("/api/", ""), at: clock.now() });
    return slack.fetcher(req);
  };

  let posts = 0;
  slack.respond("POST", "/api/chat.postMessage", ({ body }) =>
    Response.json({ ok: true, channel: formField(body, "channel"), ts: `${Math.floor(clock.now() / 1000)}.${String(++posts).padStart(6, "0")}` }),
  );
  slack.respond("POST", "/api/chat.update", ({ body }) => Response.json({ ok: true, channel: formField(body, "channel"), ts: formField(body, "ts") }));
  slack.respond("POST", "/api/users.lookupByEmail", () => Response.json({ ok: false, error: "users_not_found" }));

  let checkRuns = 0;
  serveInstallationTokens(gh, clock.now());
  gh.respond("POST", "/repos/:owner/:repo/check-runs", () => Response.json({ id: ++checkRuns }, { status: 201 }));
  gh.respond("PATCH", "/repos/:owner/:repo/check-runs/:id", ({ params }) => Response.json({ id: Number(params.id) }));

  await clearTables();
});

afterEach(() => {
  Object.assign(env, saved);
});

function agentOf(tenant: Tenant): Agent {
  return { agentId: tenant.agentId, credential: tenant.credential, stub: env.AGENT_DO.get(env.AGENT_DO.idFromName(tenant.agentId)) };
}

/** Runs the stub's alarm if it is due by the test clock, as the runtime would. */
async function alarmIfDue(stub: DurableObjectStub): Promise<void> {
  const due = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
  if (due !== null && due <= clock.now()) await runDurableObjectAlarm(stub);
}

/**
 * Moves the clock one tick a second at a time, running every due Slack queue
 * alarm each second: the per-channel bucket holds one token, so one alarm sends
 * at most one post per channel however far the clock moved. Then, while the
 * agents have spoken recently, runs every due AgentDO alarm (the checks coalescer flush).
 */
async function tick(agents: readonly Agent[], teams: readonly string[]): Promise<void> {
  const queues = teams.map((team) => env.SLACK_DO.get(env.SLACK_DO.idFromName(team)));
  for (let moved = 0; moved < tickMs; moved += 1_000) {
    clock.advance(Math.min(1_000, tickMs - moved));
    await Promise.all(queues.map(alarmIfDue));
  }
  if (clock.now() - lastFrameAt < AGENT_ALARM_WINDOW_MS) await Promise.all(agents.map((agent) => alarmIfDue(agent.stub)));
  // The sinks' fan-out runs in the DO's waitUntil after each frame's ack and
  // signals nothing the test can await, so each tick yields real time to it.
  // Promise.withResolvers needs lib es2024, which the hub's tsconfig does not include.
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

/** Ticks until work settles. */
async function pump<T>(work: Promise<T>, agents: readonly Agent[], teams: readonly string[]): Promise<T> {
  let settled = false;
  const done = () => {
    settled = true;
  };
  work.then(done, done);
  while (!settled) await tick(agents, teams);
  return work;
}

/** Ticks until every Slack queue is empty and no fake has been called for 8 ticks in a row. */
async function settle(agents: readonly Agent[], teams: readonly string[]): Promise<void> {
  let quiet = 0;
  let seen = -1;
  for (let i = 0; i < 2_000 && quiet < 8; i++) {
    await tick(agents, teams);
    const calls = slackCalls.length + gh.calls.length;
    const stats = await Promise.all(
      teams.map(async (team) => (await env.SLACK_DO.get(env.SLACK_DO.idFromName(team)).fetch("https://do/queue-stats")).json<SlackQueueStats>()),
    );
    quiet = calls === seen && stats.every((s) => s.depth === 0) ? quiet + 1 : 0;
    seen = calls;
  }
  expect(quiet).toBe(8);
}

/** The agent's end of one socket: numbers event and annotations frames as its outbox would. */
function agentDriver(sock: AgentSocket): (frame: Frame) => Promise<void> {
  let agentSeq = 0;
  return async (frame) => {
    const numbered = frame.type === "event" || frame.type === "annotations" ? { ...frame, agent_seq: ++agentSeq } : frame;
    lastFrameAt = clock.now();
    await sock.request(numbered);
  };
}

/** One run after accepted, in phases: frames in a phase may go in any order, phases go in order. */
function runPhases(runId: string, jobs: readonly string[], steps: number): Frame[][] {
  const phases: Frame[][] = [
    [{ type: "job_planned", run_id: runId, jobs: jobs.map((name) => ({ name, needs: [] })) }],
    [{ type: "event", run_id: runId, state: "running" }],
  ];
  for (let i = 0; i < steps; i++) {
    phases.push(jobs.map((job) => ({ type: "event", run_id: runId, job, state: "running", step: `step ${i + 1}`, step_index: i, steps_total: steps })));
  }
  phases.push(jobs.map((job) => ({ type: "event", run_id: runId, job, state: "success", duration_ms: 42_000 })));
  phases.push([
    {
      type: "annotations",
      run_id: runId,
      job: jobs.at(-1),
      items: [{ path: "src/main.go", line: 12, level: "warning", message: "unused variable x", title: "unused" }],
    },
  ]);
  phases.push([{ type: "event", run_id: runId, state: "success" }]);
  return phases;
}

async function runStates(db: D1Database, runIds: readonly string[]): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare("SELECT run_id, state, finished_at FROM runs WHERE run_id IN (SELECT value FROM json_each(?1)) ORDER BY run_id")
    .bind(JSON.stringify(runIds))
    .all<Record<string, unknown>>();
  return results;
}

describe("D1 writes and Slack calls under load", () => {
  it(`writes at most ${D1_ROWS_PER_RUN_BUDGET} D1 rows for one run of 3 jobs x 10 steps`, { timeout: 30_000 }, async () => {
    const errors = vi.spyOn(console, "error");
    const tenant = await seedTenant(env, { installationId: 1, teamId: "T0BUDGET1" });
    const agent = agentOf(tenant);
    const sock = await connect(agent);
    expect(await sock.hello()).toMatchObject({ type: "welcome" });

    const counter = countingD1(env.DB);
    env.DB = counter.db;

    const sha = "b".repeat(40);
    const body = JSON.stringify({
      ...pushMain,
      after: sha,
      head_commit: { ...pushMain.head_commit, id: sha },
      repository: { ...pushMain.repository, id: tenant.repoId, name: "api", full_name: tenant.fullName, owner: { ...pushMain.repository.owner, login: "org1" } },
      installation: { ...pushMain.installation, id: tenant.installationId },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://hub.test/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-github-delivery": "budget-1",
          "x-hub-signature-256": `sha256=${hex(await hmacSha256(env.GITHUB_WEBHOOK_SECRET, body))}`,
        },
        body,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(202);

    const trigger = await sock.next();
    expect(trigger).toMatchObject({ type: "trigger", sha, ref: "refs/heads/main" });
    const runId = String(trigger.trigger_id);
    const send = agentDriver(sock);
    const drive = async () => {
      await send({ type: "accepted", trigger_id: runId, run_id: runId });
      for (const phase of runPhases(runId, JOBS, STEPS)) for (const frame of phase) await send(frame);
    };
    await pump(drive(), [agent], [tenant.teamId]);
    await settle([agent], [tenant.teamId]);

    const total = counter.total();
    console.log(`D1 rows written for one run: ${total}`, counter.byTable());
    expect(total).toBeLessThanOrEqual(D1_ROWS_PER_RUN_BUDGET);
    expect(await runStates(saved.DB, [runId])).toEqual([{ run_id: runId, state: "success", finished_at: expect.any(Number) }]);
    expect(slackCalls).toContainEqual(expect.objectContaining({ team: tenant.teamId, method: "chat.postMessage" }));
    expect(gh.calls).toContainEqual(expect.objectContaining({ method: "POST", url: `https://api.github.com/repos/${tenant.fullName}/check-runs` }));
    // The aggregate zeroci check is the first one created, so the fake gave it id 1.
    expect(gh.calls).toContainEqual(
      expect.objectContaining({
        method: "PATCH",
        url: `https://api.github.com/repos/${tenant.fullName}/check-runs/1`,
        body: expect.objectContaining({ status: "completed", conclusion: "success" }),
      }),
    );
    expect(errors).not.toHaveBeenCalled();
  });

  it(`drives 50 concurrent runs across 5 installations within ${QUOTAS.slackWorkspacePerMin} Slack calls per workspace per minute`, { timeout: 90_000 }, async () => {
    const errors = vi.spyOn(console, "error");
    const start = clock.now();
    const tenants = await Promise.all([2, 3, 4, 5, 6].map((installationId) => seedTenant(env, { installationId, teamId: `T0LOAD${installationId}` })));
    const agents = tenants.map(agentOf);
    const teams = tenants.map((t) => t.teamId);

    const runIds = (
      await Promise.all(
        tenants.map(async (tenant, a) => {
          const agent = agents[a]!;
          const sock = await connect(agent);
          expect(await sock.hello()).toMatchObject({ type: "welcome" });
          const ids: string[] = [];
          for (let r = 1; r <= 10; r++) {
            const res = await agent.stub.fetch("https://do/trigger", {
              method: "POST",
              headers: { "x-zeroci-agent-id": agent.agentId },
              body: JSON.stringify({
                installationId: tenant.installationId,
                repoId: tenant.repoId,
                repo: tenant.fullName,
                sha: `${tenant.installationId}${String(r).padStart(2, "0")}`.padEnd(40, "c"),
                ref: `refs/heads/feature-${r}`,
                event: "pull_request",
                pr: { number: 100 + r, headRef: `feature-${r}`, headRepoFullName: tenant.fullName, fork: false, authorLogin: tenant.githubLogin },
                baseSha: "a".repeat(40),
                authorLogin: tenant.githubLogin,
                commitTitle: `Change ${r}`,
                defaultBranch: "main",
                target: "checks",
                trust: "trusted",
              } satisfies TriggerRequest),
            });
            expect(res.status).toBe(202);
            const { trigger_id } = await res.json<{ trigger_id: string }>();
            expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id });
            ids.push(trigger_id);
          }
          return { sock, ids };
        }),
      )
    ).map(({ sock, ids }) => ({ send: agentDriver(sock), ids }));

    // Each agent interleaves its 10 runs phase by phase; the 5 agents go in parallel.
    // A run here is 1 job x 1 step: the load is in the number of runs, and the
    // per-frame cost of 3 x 10 steps for 50 runs would not fit the test's time.
    tickMs = 10_000;
    const drive = Promise.all(
      runIds.map(async ({ send, ids }) => {
        for (const id of ids) await send({ type: "accepted", trigger_id: id, run_id: id });
        const phases = ids.map((id) => runPhases(id, ["build"], 1));
        for (let p = 0; p < (phases[0]?.length ?? 0); p++) {
          for (const run of phases) for (const frame of run[p] ?? []) await send(frame);
        }
      }),
    );
    await pump(drive, agents, teams);
    await settle(agents, teams);

    expect(errors).not.toHaveBeenCalled();
    const all = runIds.flatMap(({ ids }) => ids);
    expect(all).toHaveLength(50);
    const states = await runStates(env.DB, all);
    expect(states.map((r) => r.state)).toEqual(all.map(() => "success"));

    const quota = QUOTAS.slackWorkspacePerMin;
    const perMinute = new Map<string, number>();
    const sent = new Map<string, number>();
    const overQuota: string[] = [];
    for (const call of slackCalls) {
      const key = `${call.team} minute ${Math.floor((call.at - start) / 60_000)}`;
      perMinute.set(key, (perMinute.get(key) ?? 0) + 1);
      // The workspace bucket starts with `quota` tokens and refills `quota` per
      // minute, so a fixed minute may hold the starting burst plus a minute of
      // refill. The bound it does keep: by any time, at most `quota` calls plus
      // `quota` per simulated minute since the start.
      const n = (sent.get(call.team) ?? 0) + 1;
      sent.set(call.team, n);
      const allowed = quota + Math.floor(((call.at - start) * quota) / 60_000);
      if (n > allowed) overQuota.push(`${call.team} call ${n} at +${call.at - start} ms, allowed ${allowed}`);
    }
    console.log("Slack calls per workspace per minute", Object.fromEntries(perMinute));
    expect(new Set(slackCalls.map((c) => c.team))).toEqual(new Set(teams));
    expect(overQuota).toEqual([]);
  });
});
