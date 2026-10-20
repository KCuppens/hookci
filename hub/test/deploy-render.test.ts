import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bind } from "../src/db/bindings";
import { upsertInstallation } from "../src/db/installations";
import { upsertRepos } from "../src/db/repos";
import { tenantDb } from "../src/db/tenant";
import { addWatch } from "../src/db/watches";
import { type CheckConclusion, dispatchDeployTrigger, onCheckConcluded } from "../src/deploy/chain";
import { getDeployRender, renderDeployAlert, renderDeployBadge } from "../src/deploy/render";
import { clearTables } from "./db/helpers";
import { type AgentSocket, connect, seedAgent } from "./do/agent-socket";
import { after, formField, queueStats, useQueueWorld } from "./do/slack-queue-world";
import type { FakeCall } from "./fakes/http";
import { generateAppKey } from "./github/helpers";

const INSTALLATION = 91;
const REPO = 3003;
const CHANNEL = "C0DEPLOY";
const SHA = "a".repeat(40);
const RUN = "run_deploy_1";
const t = tenantDb(env.DB, INSTALLATION);

const PUSH_SUCCESS: CheckConclusion = {
  installationId: INSTALLATION,
  repo: "acme/widgets",
  sha: SHA,
  ref: "refs/heads/main",
  event: "push",
  conclusion: "success",
};

describe("deploy badge rendering", () => {
  it("renderDeployBadge running", () => {
    const msg = renderDeployBadge({ env: "staging", sha: "abc1234def", state: "running", step: "migrate", stepIndex: 2, stepsTotal: 8 });
    expect(msg.text).toBe("staging · abc1234 · 3/8 migrate");
    expect(JSON.stringify(msg.blocks)).toContain("staging · abc1234 · 3/8 migrate");
  });

  it("renderDeployBadge success", () => {
    const msg = renderDeployBadge({ env: "staging", sha: "abc1234def", state: "succeeded", durationMs: 124000, logUrl: "https://hub.test/log" });
    expect(msg.text).toBe("staging · abc1234 · 2m04s · health ok · log");
    expect(JSON.stringify(msg.blocks)).toContain("<https://hub.test/log|log>");
    expect(renderDeployBadge({ env: "staging", sha: "abc1234", state: "succeeded", durationMs: 41000 }).text).toBe("staging · abc1234 · 41s · health ok");
  });

  it("renderDeployBadge failure rolled back", () => {
    const failed = { env: "staging", sha: "abc1234def", state: "failed" as const, step: "health", stepIndex: 4, stepsTotal: 8, logUrl: "https://hub.test/log", runId: "run_9", attempt: 2 };
    const msg = renderDeployBadge({ ...failed, rolledBack: true });
    expect(msg.text).toBe("staging · abc1234 · failed at 5/8 health · rolled back · log");
    expect(msg.blocks).toContainEqual({
      type: "actions",
      elements: [{ type: "button", action_id: "zeroci_deploy_retry", text: { type: "plain_text", text: "Retry", emoji: true }, value: "run_9:2" }],
    });
    expect(renderDeployBadge(failed).text).toBe("staging · abc1234 · failed at 5/8 health · log");
  });

  it("renderDeployBadge stopped states are not failures and get no Retry", () => {
    const base = { env: "staging", sha: "abc1234def", step: "health", stepIndex: 4, stepsTotal: 8, runId: "run_9", attempt: 1 };
    expect(renderDeployBadge({ ...base, state: "interrupted" }).text).toBe("staging · abc1234 · interrupted");
    expect(renderDeployBadge({ ...base, state: "cancelled" }).text).toBe("staging · abc1234 · cancelled");
    expect(renderDeployBadge({ ...base, state: "superseded" }).text).toBe("staging · abc1234 · superseded by a newer deploy");
    for (const state of ["interrupted", "cancelled", "superseded"] as const) {
      expect(JSON.stringify(renderDeployBadge({ ...base, state }).blocks)).not.toContain("zeroci_deploy_retry");
    }
  });

  it("renderDeployAlert keeps the last 40 tail lines", () => {
    const tail = Array.from({ length: 100 }, (_, i) => `out-${i + 1}-end`);
    const msg = renderDeployAlert({ env: "staging", sha: "abc1234", state: "failed", step: "health", stepIndex: 4, stepsTotal: 8 }, tail, "<@U123>");
    const blocks = JSON.stringify(msg.blocks);
    expect(msg.text).toContain("<@U123>");
    expect(blocks.match(/out-\d+-end/g)).toHaveLength(40);
    expect(blocks).toContain("out-61-end");
    expect(blocks).not.toContain("out-60-end");
  });
});

describe("deploy rendering through the agent", () => {
  beforeEach(clearTables);
  const world = useQueueWorld();
  let sock: AgentSocket | undefined;
  let pem: string;
  let nextTs: number;
  let agentSeq: number;
  const savedKey = env.GITHUB_APP_PRIVATE_KEY;

  beforeEach(async () => {
    pem ??= (await generateAppKey()).pem;
    env.GITHUB_APP_PRIVATE_KEY = pem;
    await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", account_id: INSTALLATION * 10, created_at: 1 });
    await upsertRepos(t, [{ repo_id: REPO, full_name: "acme/widgets", default_branch: "main" }]);
    await addWatch(t, { repo_id: REPO, team_id: world.team, channel_id: CHANNEL, notify: "normal", alert: "channel", created_by: "U0CREATOR" });
    nextTs = 1;
    agentSeq = 0;
    world.slack.respond("POST", "/api/chat.postMessage", ({ body }) =>
      Response.json({ ok: true, channel: formField(body, "channel"), ts: `1700000000.${String(nextTs++).padStart(6, "0")}` }),
    );
    world.slack.respond("POST", "/api/chat.update", ({ body }) => Response.json({ ok: true, ts: formField(body, "ts") }));
    // GitHub shares the fetcher with the fake Slack: paths do not overlap.
    world.slack.respond("POST", "/app/installations/:id/access_tokens", () =>
      Response.json({ token: "ghs_deploy", expires_at: "2030-01-01T00:00:00Z" }, { status: 201 }),
    );
    let checkId = 500;
    world.slack.respond("POST", "/repos/:owner/:repo/check-runs", () => Response.json({ id: checkId++ }, { status: 201 }));
    world.slack.respond("PATCH", "/repos/:owner/:repo/check-runs/:id", ({ params }) => Response.json({ id: Number(params.id) }));
  });

  afterEach(() => {
    sock?.ws.close();
    sock = undefined;
    env.GITHUB_APP_PRIVATE_KEY = savedKey;
  });

  function calls(path: string): FakeCall[] {
    return world.slack.calls.filter((call) => new URL(call.url).pathname === path);
  }

  function blocksOf(call: FakeCall | undefined): string {
    const blocks = formField(call?.body, "blocks");
    return typeof blocks === "string" ? blocks : JSON.stringify(blocks);
  }

  async function drain(): Promise<void> {
    for (let i = 0; i < 30 && (await queueStats(world)).depth > 0; i++) await after(world, 1000);
    expect((await queueStats(world)).depth).toBe(0);
  }

  /** Runs the queue's alarm a second at a time until pending settles, so waited Slack calls retry and time out. */
  async function pumped<T>(pending: Promise<T>): Promise<T> {
    let settled = false;
    void pending.finally(() => (settled = true)).catch(() => {});
    for (let i = 0; i < 120 && !settled; i++) await after(world, 1000);
    return pending;
  }

  /** Connects a staging deploy agent, sends it the push's deploy trigger and returns the trigger frame. */
  async function deployTrigger(): Promise<{ socket: AgentSocket; triggerId: string }> {
    const agent = await seedAgent(INSTALLATION);
    await bind(t, REPO, "deploy:staging", agent.agentId);
    const socket = await connect(agent);
    sock = socket;
    expect(await socket.hello()).toMatchObject({ type: "welcome" });
    expect(await onCheckConcluded(env, PUSH_SUCCESS)).toBe(1);
    const trigger = await socket.next();
    return { socket, triggerId: String(trigger.trigger_id) };
  }

  async function acceptedDeploy(author = "alice"): Promise<AgentSocket> {
    const { socket, triggerId } = await deployTrigger();
    await socket.request({ type: "accepted", trigger_id: triggerId, run_id: RUN });
    await env.DB.prepare("UPDATE runs SET author_login = ?1 WHERE run_id = ?2").bind(author, RUN).run();
    return socket;
  }

  async function event(socket: AgentSocket, frame: Record<string, unknown>): Promise<void> {
    await socket.request({ type: "event", agent_seq: ++agentSeq, run_id: RUN, ...frame });
  }

  it("onDeployEvent posts once then updates", async () => {
    const socket = await acceptedDeploy();
    await event(socket, { state: "running" });
    await event(socket, { job: "deploy", state: "running", step: "migrate", step_index: 2, steps_total: 8 });
    await drain();
    await event(socket, { state: "success", duration_ms: 124000 });
    await drain();

    const posts = calls("/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(formField(posts[0]?.body, "channel")).toBe(CHANNEL);
    const updates = calls("/api/chat.update");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    for (const update of updates) expect(formField(update.body, "ts")).toBe("1700000000.000001");
    expect(updates.map((u) => formField(u.body, "text"))).toContain("staging · aaaaaaa · 3/8 migrate");
    expect(formField(updates.at(-1)?.body, "text")).toBe("staging · aaaaaaa · 2m04s · health ok · log");
    expect(blocksOf(updates.at(-1))).toMatch(/<https:[^|]+\|log>/);
    expect(await getDeployRender(env.DB, RUN)).toMatchObject({ slack_channel: CHANNEL, slack_ts: "1700000000.000001", state: "succeeded" });
  });

  it("alert only on final failure", async () => {
    await env.DB.prepare("INSERT INTO user_links (team_id, slack_user_id, github_user_id, github_login, created_at) VALUES (?1, 'U123', 7, 'alice', 1)")
      .bind(world.team)
      .run();
    const socket = await acceptedDeploy("alice");
    await event(socket, { state: "running" });
    await event(socket, { job: "deploy", state: "running", step: "health", step_index: 4, steps_total: 8 });
    await event(socket, { state: "rolling_back" });
    await drain();
    const alerts = () => calls("/api/chat.postMessage").filter((c) => String(formField(c.body, "text")).startsWith("<@U123>"));
    expect(alerts()).toEqual([]);

    const tail = Array.from({ length: 100 }, (_, i) => `out-${i + 1}-end`);
    await event(socket, { state: "failed", duration_ms: 90000, tail });
    await event(socket, { state: "failed", duration_ms: 90000, tail });
    await drain();

    expect(alerts()).toHaveLength(1);
    const alert = blocksOf(alerts()[0]);
    expect(alert).toContain("<@U123>");
    expect(alert.match(/out-\d+-end/g)).toHaveLength(40);
    expect(alert).toContain("out-100-end");
    expect(alert).not.toContain("out-60-end");
    expect(formField(alerts()[0]?.body, "channel")).toBe(CHANNEL);
    expect(formField(calls("/api/chat.update").at(-1)?.body, "text")).toBe("staging · aaaaaaa · failed at 5/8 health · rolled back · log");
  });

  it("alert without link", async () => {
    const socket = await acceptedDeploy("bob");
    await event(socket, { state: "running" });
    await event(socket, { state: "failed", tail: ["boom"] });
    await drain();
    const alert = calls("/api/chat.postMessage").find((c) => String(formField(c.body, "text")).startsWith("bob "));
    expect(alert).toBeDefined();
    expect(blocksOf(alert)).toContain("bob ");
    expect(blocksOf(alert)).not.toContain("<@");
    expect(String(formField(alert?.body, "text"))).not.toContain("<@");
  });

  it.each([
    ["interrupted", "interrupted", "cancelled", "Deploy interrupted"],
    ["cancelled", "cancelled", "cancelled", "Deploy cancelled"],
    ["superseded", "superseded by a newer deploy", "neutral", "Deploy superseded"],
  ])("a %s deploy shows its own state, sends no alert and does not fail the check", async (state, text, conclusion, title) => {
    const socket = await acceptedDeploy();
    await event(socket, { state: "running" });
    await event(socket, { state, tail: ["stopped"] });
    await drain();

    expect(calls("/api/chat.postMessage")).toHaveLength(1);
    expect(formField(calls("/api/chat.update").at(-1)?.body, "text")).toBe(`staging · aaaaaaa · ${text}`);
    expect(calls("/repos/acme/widgets/check-runs/500").at(-1)?.body).toMatchObject({ status: "completed", conclusion, output: { title } });
    expect(await getDeployRender(env.DB, RUN)).toMatchObject({ state });
  });

  it("check run informational", async () => {
    const socket = await acceptedDeploy();
    await event(socket, { state: "running" });
    await event(socket, { job: "deploy", state: "success", duration_ms: 120000 });
    await event(socket, { state: "success", duration_ms: 124000 });

    const created = calls("/repos/acme/widgets/check-runs");
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toMatchObject({ name: "zeroci/deploy:staging", head_sha: SHA, status: "in_progress" });
    const updated = calls("/repos/acme/widgets/check-runs/500");
    expect(updated.at(-1)?.body).toMatchObject({
      status: "completed",
      conclusion: "success",
      output: { summary: "staging · aaaaaaa · 2m04s · health ok · log" },
    });
    expect(await getDeployRender(env.DB, RUN)).toMatchObject({ check_run_id: 500 });
    expect(world.slack.calls.filter((c) => new URL(c.url).pathname.includes("/deployments"))).toEqual([]);
  });

  it("a retry that reuses the run id reopens the run, the badge and the check run", async () => {
    const socket = await acceptedDeploy();
    await event(socket, { state: "running" });
    await event(socket, { state: "failed", duration_ms: 90000 });
    await drain();
    expect(await getDeployRender(env.DB, RUN)).toMatchObject({ state: "failed", check_run_id: 500 });

    const first = await env.DB.prepare("SELECT agent_id FROM deploy_triggers WHERE run_id = ?1").bind(RUN).first<{ agent_id: string }>();
    const { triggerId } = await dispatchDeployTrigger(env, {
      installationId: INSTALLATION,
      repo: "acme/widgets",
      sha: SHA,
      ref: "refs/heads/main",
      envName: "staging",
      agentId: String(first?.agent_id),
      event: "retry",
      attempt: 2,
    });
    expect(await socket.next()).toMatchObject({ type: "trigger", trigger_id: triggerId, attempt: 2 });
    // The agent resumes the failed run under its own run id.
    expect(await socket.request({ type: "accepted", trigger_id: triggerId, run_id: RUN })).toEqual([]);

    const runRows = await env.DB.prepare("SELECT run_id, trigger_id, attempt, state, reason, finished_at FROM runs").all();
    expect(runRows.results).toEqual([{ run_id: RUN, trigger_id: triggerId, attempt: 2, state: "queued", reason: null, finished_at: null }]);
    expect(await getDeployRender(env.DB, RUN)).toMatchObject({ state: "queued", check_run_id: null, step: null });

    await event(socket, { state: "running" });
    await event(socket, { state: "failed", duration_ms: 30000 });
    await drain();

    expect(await env.DB.prepare("SELECT state FROM runs WHERE run_id = ?1").bind(RUN).first()).toEqual({ state: "failed" });
    expect(calls("/repos/acme/widgets/check-runs")).toHaveLength(2);
    expect(await getDeployRender(env.DB, RUN)).toMatchObject({ state: "failed", check_run_id: 501, slack_ts: "1700000000.000001" });
    expect(blocksOf(calls("/api/chat.update").at(-1))).toContain(`${RUN}:2`);
  });

  it("rejected trigger", async () => {
    const { socket, triggerId } = await deployTrigger();
    await socket.request({ type: "rejected", trigger_id: triggerId, reason: "deployments.staging: not configured" });
    await drain();
    const posts = calls("/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(formField(posts[0]?.body, "text")).toBe("staging · aaaaaaa · not started: deployments.staging: not configured");
    expect(calls("/repos/acme/widgets/check-runs")).toEqual([]);
  });

  it("a replayed rejection posts its badge once", async () => {
    const { socket, triggerId } = await deployTrigger();
    const frame = { type: "rejected", trigger_id: triggerId, reason: "deployments.staging: not configured" } as const;
    await socket.request(frame);
    await socket.request(frame);
    await drain();
    expect(calls("/api/chat.postMessage")).toHaveLength(1);
  });

  it("sink failure isolated", async () => {
    world.slack.respond("POST", "/api/chat.postMessage", () => new Response("down", { status: 500 }));
    const socket = await pumped(acceptedDeploy());
    await pumped(event(socket, { state: "running" }));
    await pumped(event(socket, { state: "failed" }));
    const run = await env.DB.prepare("SELECT state FROM runs WHERE run_id = ?1").bind(RUN).first<{ state: string }>();
    expect(run?.state).toBe("failed");
    expect(await getDeployRender(env.DB, RUN)).toMatchObject({ state: "failed", slack_ts: null });
  });
});
