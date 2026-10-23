import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSinkConfig, getSinkConfigWithSecret, getSinkMessage, type SinkConfigWithSecret } from "../../src/db/sinks";
import { tenantDb } from "../../src/db/tenant";
import type { Fetcher } from "../../src/http";
import type { OutboxDelivery } from "../../src/sinks/deliverers";
import {
  decodeLinearExternalId,
  encodeLinearExternalId,
  type LinearTarget,
  linearDeliverer,
  linearGraphql,
  mapLinearError,
  validateLinearConfig,
} from "../../src/sinks/linear";
import type { RunState, RunView } from "../../src/sinks/types";

const INSTALLATION = 289;
const API_KEY = "lin_api_SECRETKEY123";
const API_URL = "https://linear.test/graphql";
const TARGET: LinearTarget = {
  teamId: "team_1",
  teamKey: "ENG",
  assigneeId: "user_1",
  assigneeName: "Dana",
  assigneeUrl: "https://linear.app/acme/profiles/dana",
  completedStateId: "state_done",
};
const t = tenantDb(env.DB, INSTALLATION);

interface Call {
  query: string;
  variables: Record<string, any>;
}

let calls: Call[];
let answer: (op: string) => Response;
let cfg: SinkConfigWithSecret;
let saved: { fetcher: typeof env.__TEST_FETCHER; url: string };
let logged: string[];
let run = 0;

function op(query: string): string {
  return /\{\s*(\w+)/.exec(query)?.[1] ?? "";
}

function ok(operation: string): Response {
  if (operation === "issueCreate") return Response.json({ data: { issueCreate: { success: true, issue: { id: "iss_1", identifier: "ENG-1", url: "https://linear.app/i/ENG-1" } } } });
  if (operation === "issueUpdate") return Response.json({ data: { issueUpdate: { success: true } } });
  return Response.json({ data: { commentCreate: { success: true, comment: { id: `cmt_${calls.length}` } } } });
}

const recording: Fetcher = async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as Call;
  calls.push(body);
  return answer(op(body.query));
};

beforeEach(async () => {
  calls = [];
  answer = ok;
  logged = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  saved = { fetcher: env.__TEST_FETCHER, url: env.LINEAR_API_URL };
  env.LINEAR_API_URL = API_URL;
  env.__TEST_FETCHER = recording;
  const row = await createSinkConfig(env, t, { kind: "linear", repo: "o/r", target: JSON.stringify(TARGET), secret: API_KEY, createdBy: "slack:T1:U1" });
  const found = await getSinkConfigWithSecret(env, t, row.id);
  if (!found) throw new Error("sink config missing");
  cfg = found;
  run += 1;
});

afterEach(() => {
  for (const line of logged) expect(line).not.toContain(API_KEY);
  env.__TEST_FETCHER = saved.fetcher;
  env.LINEAR_API_URL = saved.url;
  vi.restoreAllMocks();
});

function view(state: RunState, jobs: RunView["jobs"] = [], target = "deploy:production"): RunView {
  return {
    installationId: INSTALLATION,
    repoId: 1,
    repo: "o/r",
    triggerId: `trg_${run}`,
    sha: `abc1234${"0".repeat(33)}`,
    shortSha: "abc1234",
    event: "push",
    target,
    state,
    commitTitle: "Ship it",
    authorLogin: "dev",
    startedAt: Date.UTC(2026, 0, 1),
    jobs,
  };
}

function deliver(v: RunView, e: typeof env = env) {
  const item: OutboxDelivery = {
    installationId: INSTALLATION,
    sinkId: cfg.id,
    runId: v.triggerId,
    terminal: false,
    payload: v,
    enqueuedAt: 0,
    deliveryId: `d${calls.length}`,
  };
  return linearDeliverer.deliver(e, cfg, item, 1);
}

const ops = () => calls.map((c) => op(c.query));
const failedJobs: RunView["jobs"] = [{ name: "deploy", state: "failed", step: "migrate", logLink: "https://hub.test/runs/r/logs?job=deploy" }];

describe("linearDeliverer", () => {
  it("creates the issue on the first update and updates it afterwards", async () => {
    expect(await deliver(view("running"))).toMatchObject({ kind: "ok" });
    expect(ops()).toEqual(["issueCreate"]);
    expect(calls[0]?.variables.input).toMatchObject({ teamId: "team_1", title: "Deploy o/r production abc1234: running" });
    expect(calls[0]?.variables.input.assigneeId).toBeUndefined();

    calls = [];
    await deliver(view("running", [{ name: "deploy", state: "running" }]));
    expect(ops()).toEqual(["issueUpdate"]);
    expect(calls[0]?.variables.id).toBe("iss_1");
  });

  it("makes no call when the content is unchanged", async () => {
    await deliver(view("running"));
    calls = [];
    expect(await deliver(view("running"))).toMatchObject({ kind: "ok" });
    expect(calls).toEqual([]);
  });

  it("moves a succeeded deploy to the completed state", async () => {
    await deliver(view("running"));
    calls = [];
    await deliver(view("success"));
    expect(ops()).toEqual(["issueUpdate"]);
    expect(calls[0]?.variables.input.stateId).toBe("state_done");
  });

  it("assigns a failed deploy and comments once", async () => {
    await deliver(view("running"));
    calls = [];
    await deliver(view("failed", failedJobs));
    expect(ops()).toEqual(["issueUpdate", "commentCreate"]);
    expect(calls[0]?.variables.input.assigneeId).toBe("user_1");
    const body: string = calls[1]?.variables.input.body;
    expect(body).toContain(TARGET.assigneeUrl);
    expect(body).toContain("deploy of o/r to production at abc1234 failed: migrate. Logs: https://hub.test/runs/r/logs?job=deploy");

    calls = [];
    await deliver({ ...view("failed", failedJobs), finishedAt: Date.UTC(2026, 0, 1, 0, 5) });
    expect(ops()).toEqual(["issueUpdate"]);
  });

  it("skips check runs without calling Linear", async () => {
    expect(await deliver(view("running", [], "checks"))).toEqual({ kind: "ok" });
    expect(calls).toEqual([]);
  });

  it("keeps the created issue when the state move fails, and updates on retry", async () => {
    answer = (operation) => (operation === "issueUpdate" ? new Response("unavailable", { status: 503 }) : ok(operation));
    expect(await deliver(view("success"))).toEqual({ kind: "retry", httpStatus: 503 });
    expect(ops()).toEqual(["issueCreate", "issueUpdate"]);
    const stored = await getSinkMessage(t, cfg.id, `trg_${run}`);
    expect(decodeLinearExternalId(stored?.externalId)?.issueId).toBe("iss_1");

    answer = ok;
    calls = [];
    expect(await deliver(view("success"))).toMatchObject({ kind: "ok" });
    expect(ops()).toEqual(["issueUpdate"]);
    expect(calls[0]?.variables.input.stateId).toBe("state_done");
  });

  it("returns the mapped Linear error when saving the created issue fails", async () => {
    answer = (operation) => (operation === "issueUpdate" ? new Response("unavailable", { status: 503 }) : ok(operation));
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("INSERT INTO sink_messages")) throw new Error("D1_ERROR: database is locked");
            return target.prepare(sql);
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(await deliver(view("success"), { ...env, DB })).toEqual({ kind: "retry", httpStatus: 503 });
    expect(ops()).toEqual(["issueCreate", "issueUpdate"]);
    expect(await getSinkMessage(t, cfg.id, `trg_${run}`)).toBeNull();
    const reported = logged.filter((line) => line.includes("linear_issue_save_failed"));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("database is locked");
  });
});

describe("mapLinearError", () => {
  const query = (res: Response) => linearGraphql(async () => res, API_URL, API_KEY, "query { viewer { id } }", {});
  const mapped = async (res: Response) => {
    const r = await query(res);
    if (r.ok) throw new Error("expected an error");
    return mapLinearError(r, Date.now());
  };

  it("waits until the rate limit resets", async () => {
    const reset = String(Date.now() + 30_000);
    const r = await mapped(new Response("{}", { status: 429, headers: { "X-RateLimit-Requests-Reset": reset } }));
    expect(r.kind).toBe("retry");
    const afterMs = r.kind === "retry" ? (r.afterMs ?? 0) : 0;
    expect(afterMs).toBeGreaterThanOrEqual(29_000);
    expect(afterMs).toBeLessThanOrEqual(30_000);
  });

  it("waits 60 s on a rate limit without a reset time", async () => {
    expect(await mapped(new Response("{}", { status: 429 }))).toEqual({ kind: "retry", afterMs: 60_000, httpStatus: 429 });
  });

  it("retries a RATELIMITED GraphQL error sent with HTTP 200", async () => {
    const r = await mapped(Response.json({ errors: [{ message: "slow down", extensions: { code: "RATELIMITED" } }] }));
    expect(r.kind).toBe("retry");
  });

  it("disables the sink on 401 and AUTHENTICATION_ERROR", async () => {
    expect(await mapped(new Response("{}", { status: 401 }))).toEqual({ kind: "fail", httpStatus: 401, disable: "linear_unauthorized" });
    expect(await mapped(Response.json({ errors: [{ message: "bad key", extensions: { code: "AUTHENTICATION_ERROR" } }] }))).toEqual({
      kind: "fail",
      httpStatus: 200,
      disable: "linear_unauthorized",
    });
  });

  it("retries a 503", async () => {
    expect(await mapped(new Response("down", { status: 503 }))).toEqual({ kind: "retry", httpStatus: 503 });
  });

  it("fails other GraphQL errors without disabling", async () => {
    expect(await mapped(Response.json({ errors: [{ message: "bad input", extensions: { code: "INVALID_INPUT" } }] }))).toEqual({ kind: "fail", httpStatus: 200 });
  });

  it("gives each call a timeout and retries one that runs out, before or while reading the body", async () => {
    const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const signals: unknown[] = [];
    const noHeaders = await linearGraphql(
      async (_input, init) => {
        signals.push(init?.signal);
        throw timedOut;
      },
      API_URL,
      API_KEY,
      "query { viewer { id } }",
      {},
    );
    const noBody = await linearGraphql(
      async (_input, init) => {
        signals.push(init?.signal);
        return new Response(new ReadableStream({ start: (controller) => controller.error(timedOut) }));
      },
      API_URL,
      API_KEY,
      "query { viewer { id } }",
      {},
    );
    expect(signals).toEqual([expect.any(AbortSignal), expect.any(AbortSignal)]);
    for (const r of [noHeaders, noBody]) {
      expect(r).toEqual({ ok: false, httpStatus: 0, message: "linear unreachable" });
      if (!r.ok) expect(mapLinearError(r, Date.now())).toEqual({ kind: "retry" });
    }
  });
});

describe("validateLinearConfig", () => {
  const DANA = { id: "user_1", name: "Dana", url: "https://linear.app/acme/profiles/dana" };
  let teams: unknown[];
  let users: unknown[];
  let states: unknown[];

  beforeEach(() => {
    teams = [{ id: "team_1", key: "ENG" }];
    users = [DANA];
    states = [
      { id: "state_late", position: 3 },
      { id: "state_done", position: 1 },
    ];
    answer = (operation) => {
      if (operation === "viewer") return Response.json({ data: { viewer: { id: "me" } } });
      if (operation === "teams") return Response.json({ data: { teams: { nodes: teams } } });
      if (operation === "users") return Response.json({ data: { users: { nodes: users } } });
      return Response.json({ data: { team: { states: { nodes: states } } } });
    };
  });

  const validate = (assigneeEmail?: string) => validateLinearConfig(recording, API_URL, API_KEY, "ENG", assigneeEmail);

  it("resolves the team, the assignee and the completed state with the lowest position", async () => {
    expect(await validate("dana@acme.test")).toEqual({ ok: true, target: TARGET });
    expect(calls.map((c) => op(c.query))).toEqual(["viewer", "teams", "users", "team"]);
    expect(calls.map((c) => c.variables)).toEqual([{}, { key: "ENG" }, { email: "dana@acme.test" }, { teamId: "team_1" }]);
  });

  it("makes exactly 3 calls and stores no assignee without an email", async () => {
    expect(await validate()).toEqual({ ok: true, target: { teamId: "team_1", teamKey: "ENG", completedStateId: "state_done" } });
    expect(calls.map((c) => op(c.query))).toEqual(["viewer", "teams", "team"]);
  });

  it("leaves completedStateId out when the team has no completed state", async () => {
    states = [];
    const result = await validate();
    expect(result).toEqual({ ok: true, target: { teamId: "team_1", teamKey: "ENG" } });
  });

  it("answers bad_token when Linear refuses the key, and asks nothing more", async () => {
    answer = () => new Response("{}", { status: 401 });
    expect(await validate("dana@acme.test")).toEqual({ ok: false, code: "bad_token" });
    answer = () => Response.json({ errors: [{ message: "bad key", extensions: { code: "AUTHENTICATION_ERROR" } }] });
    expect(await validate("dana@acme.test")).toEqual({ ok: false, code: "bad_token" });
    expect(calls.map((c) => op(c.query))).toEqual(["viewer", "viewer"]);
  });

  it("answers team_not_found when no team has the key", async () => {
    teams = [];
    expect(await validate("dana@acme.test")).toEqual({ ok: false, code: "team_not_found" });
    expect(calls).toHaveLength(2);
  });

  it("answers assignee_not_found when no user has the email", async () => {
    users = [];
    expect(await validate("nobody@acme.test")).toEqual({ ok: false, code: "assignee_not_found" });
    expect(calls).toHaveLength(3);
  });

  it("answers invalid with a retry hint when Linear rate limits or fails", async () => {
    const base = answer;
    answer = (operation) => (operation === "team" ? new Response("{}", { status: 429 }) : base(operation));
    expect(await validate()).toEqual({ ok: false, code: "invalid", retry: true });
    answer = () => new Response("down", { status: 503 });
    expect(await validate()).toEqual({ ok: false, code: "invalid", retry: true });
  });
});

describe("LinearExternalId", () => {
  it("round-trips and rejects garbage", () => {
    const x = { issueId: "iss_1", identifier: "ENG-1", url: "https://linear.app/i/ENG-1", failureCommentId: "cmt_1" };
    expect(decodeLinearExternalId(encodeLinearExternalId(x))).toEqual(x);
    expect(decodeLinearExternalId("garbage")).toBeNull();
    expect(decodeLinearExternalId(null)).toBeNull();
  });
});

describe("sink_configs linear migration", () => {
  it("keeps existing rows through the rebuild and accepts linear but not email", async () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0015_"));
    if (!migration) throw new Error("migration 0015 missing");
    const tg = await createSinkConfig(env, t, { kind: "telegram", repo: "o/r", target: "-100", secret: "1:TOKEN", createdBy: "slack:T1:U1" });
    await env.DB.batch(migration.queries.map((q) => env.DB.prepare(q)));
    const lin = await createSinkConfig(env, t, { kind: "linear", repo: "o/r", target: JSON.stringify(TARGET), secret: API_KEY, createdBy: "slack:T1:U1" });

    expect((await getSinkConfigWithSecret(env, t, tg.id))?.secret).toBe("1:TOKEN");
    expect((await getSinkConfigWithSecret(env, t, lin.id))?.kind).toBe("linear");
    await expect(
      env.DB.prepare(
        "INSERT INTO sink_configs (installation_id, id, kind, repo, target, created_by, created_at) VALUES (?1, 'snk_email', 'email', 'o/r', 'x', 'a', 1)",
      )
        .bind(INSTALLATION)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });
});
