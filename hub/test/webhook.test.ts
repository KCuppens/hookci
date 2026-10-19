import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex, hmacSha256 } from "../src/crypto";
import { bind } from "../src/db/bindings";
import { markDelivery } from "../src/db/deliveries";
import { markDeleted, markSuspended, upsertInstallation } from "../src/db/installations";
import { tenantDb } from "../src/db/tenant";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { TriggerRequest } from "../src/webhook/route";
import * as outcome from "../src/webhook/outcome";
import { clearTables } from "./db/helpers";
import { recordSink } from "./sinks/recording";
import prOpened from "./fixtures/github/pull_request.opened.json";
import prFork from "./fixtures/github/pull_request.synchronize.fork.json";
import pushBranch from "./fixtures/github/push.branch.json";
import pushMain from "./fixtures/github/push.main.json";

const INSTALLATION = 42;
const REPO = 1001;
const AGENT = "01hzagentaaaaaaaaaaaaaaaaa";
const NOW = 1_767_225_600_000;

type DoCall = { agentId: string; method: string; url: string; body: TriggerRequest };

type FakeAgentDOs = { namespace: Env["AGENT_DO"]; calls: DoCall[] };

/** AgentDO namespace whose stubs record each request and answer with respond(). */
function fakeAgentDOs(respond: () => Response = () => new Response(null, { status: 202 })): FakeAgentDOs {
  const calls: DoCall[] = [];
  const namespace: Pick<DurableObjectNamespace, "idFromName" | "get"> = {
    idFromName: (name) => ({ name, toString: () => name, equals: (other) => other.toString() === name }),
    get: (id) =>
      ({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = new Request(input, init);
          calls.push({ agentId: id.toString(), method: req.method, url: req.url, body: await req.json<TriggerRequest>() });
          return respond();
        },
      }) as unknown as DurableObjectStub,
  };
  return { namespace: namespace as unknown as Env["AGENT_DO"], calls };
}

let agents: FakeAgentDOs;

async function deliver(
  event: string,
  payload: unknown,
  { id = crypto.randomUUID(), signature }: { id?: string; signature?: string | null } = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers = new Headers({ "content-type": "application/json", "x-github-event": event, "x-github-delivery": id });
  const sig = signature === undefined ? `sha256=${hex(await hmacSha256(env.GITHUB_WEBHOOK_SECRET, body))}` : signature;
  if (sig !== null) headers.set("x-hub-signature-256", sig);
  const testEnv: Env = { ...env, AGENT_DO: agents.namespace };
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://hub.test/github/webhook", { method: "POST", headers, body }), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

type StoredDelivery = { delivery_id: string; received_at: number; expires_at: number; event: string; installation_id: number | null; status: string; note: string | null };

async function deliveries(): Promise<StoredDelivery[]> {
  const { results } = await env.DB.prepare("SELECT * FROM deliveries ORDER BY received_at, delivery_id").all<StoredDelivery>();
  return results;
}

async function deliveryRow(id: string): Promise<StoredDelivery | null> {
  return env.DB.prepare("SELECT * FROM deliveries WHERE delivery_id = ?1").bind(id).first<StoredDelivery>();
}

/** Error lines reportError wrote to console.error, parsed. */
function reportedErrors(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
}

beforeEach(async () => {
  await clearTables();
  agents = fakeAgentDOs();
  await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", created_at: NOW });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("POST /github/webhook signature", () => {
  it("answers 401 to a bad signature without recording the delivery", async () => {
    const res = await deliver("push", pushMain, { signature: "sha256=" + "0".repeat(64) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "bad_signature" });
    expect(await deliveries()).toEqual([]);
  });

  it("answers 401 to a missing signature", async () => {
    const res = await deliver("push", pushMain, { signature: null });
    expect(res.status).toBe(401);
    expect(await deliveries()).toEqual([]);
  });

  it("accepts a body signed with the previous secret during a rotation", async () => {
    const body = JSON.stringify(pushBranch);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://hub.test/github/webhook", {
        method: "POST",
        headers: {
          "x-github-event": "push",
          "x-github-delivery": "rotated",
          "x-hub-signature-256": `sha256=${hex(await hmacSha256("old-secret", body))}`,
        },
        body,
      }),
      { ...env, GITHUB_WEBHOOK_SECRET_PREVIOUS: "old-secret" },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(202);
    expect((await deliveryRow("rotated"))?.status).toBe("processed");
  });
});

describe("POST /github/webhook deliveries", () => {
  beforeEach(async () => {
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "checks", AGENT);
  });

  it("records a valid delivery once and answers a replay with duplicate:true", async () => {
    const first = await deliver("push", pushMain, { id: "d-1" });
    expect(first.status).toBe(202);
    expect(await deliveries()).toEqual([
      expect.objectContaining({ delivery_id: "d-1", event: "push", installation_id: INSTALLATION, status: "processed", note: null }),
    ]);

    const replay = await deliver("push", pushMain, { id: "d-1" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ duplicate: true });
    expect(await deliveries()).toHaveLength(1);
    expect(agents.calls).toHaveLength(1);
  });

  it("keeps a delivery for 7 days after receipt", async () => {
    await deliver("push", pushMain, { id: "d-ttl" });
    const row = await deliveryRow("d-ttl");
    expect(row!.expires_at - row!.received_at).toBe(604_800_000);
  });

  it("processes a redelivery of a failed delivery again", async () => {
    await deliver("push", pushMain, { id: "d-retry" });
    await markDelivery(env.DB, "d-retry", "failed", "agent_do_failed");
    const res = await deliver("push", pushMain, { id: "d-retry" });
    expect(res.status).toBe(202);
    expect(agents.calls).toHaveLength(2);
    expect(await deliveryRow("d-retry")).toMatchObject({ status: "processed", note: null });
  });

  it("drops the 601st delivery of an installation within one minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    for (let i = 1; i <= 600; i++) expect((await deliver("push", pushBranch, { id: `r-${i}` })).status).toBe(202);
    const res = await deliver("push", pushMain, { id: "r-601" });
    expect(res.status).toBe(202);
    expect(await deliveryRow("r-600")).toMatchObject({ status: "processed", note: null });
    expect(await deliveryRow("r-601")).toMatchObject({ status: "dropped", note: "rate_limited" });
    expect(agents.calls).toEqual([]);
  }, 60_000);

  it("marks the delivery failed and reports the error when its handler throws", async () => {
    agents = fakeAgentDOs(() => new Response("boom", { status: 500 }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await deliver("push", pushMain, { id: "d-fail" });
    expect(res.status).toBe(202);
    expect(await deliveryRow("d-fail")).toMatchObject({ status: "failed", note: "agent_do_failed" });
    expect(reportedErrors(errors)).toEqual([
      expect.objectContaining({
        level: "error",
        delivery_id: "d-fail",
        event: "push",
        installation_id: INSTALLATION,
        error: expect.objectContaining({ name: "HubError", code: "agent_do_failed" }),
      }),
    ]);
  });

  it("records events without a handler and runs nothing", async () => {
    const res = await deliver("check_suite", { action: "requested", installation: { id: INSTALLATION } }, { id: "d-suite" });
    expect(res.status).toBe(202);
    expect(await deliveryRow("d-suite")).toMatchObject({ status: "processed", installation_id: INSTALLATION });
    expect(agents.calls).toEqual([]);
  });
});

describe("POST /github/webhook routing", () => {
  it("sends a bound repo's trigger to its agent, trusted for same-repo events", async () => {
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "checks", AGENT);
    await deliver("pull_request", prOpened);
    await deliver("push", pushMain);
    expect(agents.calls).toEqual([
      expect.objectContaining({
        agentId: AGENT,
        method: "POST",
        url: "https://do/trigger",
        body: expect.objectContaining({ event: "pull_request", sha: prOpened.pull_request.head.sha, trust: "trusted" }),
      }),
      expect.objectContaining({
        agentId: AGENT,
        method: "POST",
        url: "https://do/trigger",
        body: expect.objectContaining({ event: "push", ref: "refs/heads/main", trust: "trusted" }),
      }),
    ]);
  });

  it("sends a fork pull request untrusted", async () => {
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "checks", AGENT);
    await deliver("pull_request", prFork);
    expect(agents.calls).toHaveLength(1);
    expect(agents.calls[0]!.url).toBe("https://do/trigger");
    expect(agents.calls[0]!.body).toMatchObject({ trust: "untrusted", pr: { number: 9, fork: true } });
  });

  it("records a pending no_agent run for an unbound repo and notifies once", async () => {
    const notify = vi.spyOn(outcome, "notifyOutcome");
    const sink = recordSink();
    const res = await deliver("pull_request", prOpened, { id: "d-unbound" }).finally(sink.undo);
    expect(res.status).toBe(202);
    expect(agents.calls).toEqual([]);
    const { results } = await env.DB.prepare("SELECT * FROM runs").all();
    expect(results).toEqual([
      expect.objectContaining({
        installation_id: INSTALLATION,
        repo_id: REPO,
        sha: prOpened.pull_request.head.sha,
        ref: "refs/pull/7/head",
        event: "pull_request",
        pr_number: 7,
        env: null,
        agent_id: null,
        state: "pending",
        reason: "no_agent",
        author_login: "alice",
        commit_title: "Add widget sizing",
      }),
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    const [, trig, routed] = notify.mock.calls[0] ?? [];
    expect(trig).toMatchObject({ repoId: REPO, event: "pull_request" });
    expect(routed).toEqual({ kind: "no_agent" });
    expect(sink.calls).toEqual([
      { op: "onRunUpdate", run: expect.objectContaining({ repoId: REPO, prNumber: 7, target: "checks", state: "pending", reason: "no_agent" }) },
    ]);
    expect(await deliveryRow("d-unbound")).toMatchObject({ status: "processed" });
  });

  it("records a pending suspended run instead of dispatching for a suspended installation", async () => {
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "checks", AGENT);
    await markSuspended(env.DB, INSTALLATION, NOW);
    await deliver("push", pushMain, { id: "d-suspended" });
    expect(agents.calls).toEqual([]);
    expect(await deliveryRow("d-suspended")).toMatchObject({ status: "processed" });
    const { results } = await env.DB.prepare("SELECT state, reason FROM runs").all();
    expect(results).toEqual([{ state: "pending", reason: "suspended" }]);
  });

  it("drops triggers of a deleted installation", async () => {
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "checks", AGENT);
    await markDeleted(env.DB, INSTALLATION, NOW, NOW + 86_400_000);
    await deliver("push", pushMain, { id: "d-deleted" });
    expect(agents.calls).toEqual([]);
    expect(await deliveryRow("d-deleted")).toMatchObject({ status: "dropped", note: "deleted" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>())?.n).toBe(0);
  });

  it("drops triggers of an installation the hub does not know", async () => {
    await env.DB.prepare("DELETE FROM installations").run();
    await deliver("push", pushMain, { id: "d-unknown" });
    expect(agents.calls).toEqual([]);
    expect(await deliveryRow("d-unknown")).toMatchObject({ status: "dropped", note: "unknown_installation" });
  });

  it("starts nothing for events normalize ignores", async () => {
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "checks", AGENT);
    await deliver("push", pushBranch, { id: "d-branch" });
    expect(agents.calls).toEqual([]);
    expect(await deliveryRow("d-branch")).toMatchObject({ status: "processed", note: null });
  });
});
