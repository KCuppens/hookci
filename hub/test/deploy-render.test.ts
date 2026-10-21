import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bind } from "../src/db/bindings";
import { upsertInstallation } from "../src/db/installations";
import { upsertRepos } from "../src/db/repos";
import { insertRun } from "../src/db/runs";
import { tenantDb } from "../src/db/tenant";
import { addWatch } from "../src/db/watches";
import { type CheckConclusion, dispatchDeployTrigger, onCheckConcluded } from "../src/deploy/chain";
import { getDeployRender, renderDeployBadge } from "../src/deploy/render";
import { RETRY_ACTION } from "../src/deploy/lines";
import { stableLogLink } from "../src/logs/links";
import { renderDeployFailure, renderRunMessage } from "../src/slack/messages";
import { slackSinkFactory } from "../src/sinks/slack";
import type { RunView } from "../src/sinks/types";
import { S } from "../src/strings";
import type { TriggerRequest } from "../src/webhook/route";
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
  checksRunId: "run_checks",
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
      elements: [{ type: "button", action_id: "hookci_deploy_retry", text: { type: "plain_text", text: "Retry", emoji: true }, value: "run_9:2" }],
    });
    expect(renderDeployBadge(failed).text).toBe("staging · abc1234 · failed at 5/8 health · log");
  });

  it("renderDeployBadge stopped states are not failures and get no Retry", () => {
    const base = { env: "staging", sha: "abc1234def", step: "health", stepIndex: 4, stepsTotal: 8, runId: "run_9", attempt: 1 };
    expect(renderDeployBadge({ ...base, state: "interrupted" }).text).toBe("staging · abc1234 · interrupted");
    expect(renderDeployBadge({ ...base, state: "cancelled" }).text).toBe("staging · abc1234 · cancelled");
    expect(renderDeployBadge({ ...base, state: "superseded" }).text).toBe("staging · abc1234 · superseded by a newer deploy");
    for (const state of ["interrupted", "cancelled", "superseded"] as const) {
      expect(JSON.stringify(renderDeployBadge({ ...base, state }).blocks)).not.toContain("hookci_deploy_retry");
    }
  });

  it("renderDeployFailure mentions once and keeps the last 40 tail lines", () => {
    const tail = Array.from({ length: 100 }, (_, i) => `out-${i + 1}-end`);
    const msg = renderDeployFailure("acme/widgets", { env: "staging", sha: "abc1234", state: "failed", step: "health", stepIndex: 4, stepsTotal: 8 }, tail, "U123");
    const blocks = JSON.stringify(msg.blocks);
    expect(msg.text).toBe("Deploy failed: acme/widgets · staging · abc1234 · failed at 5/8 health");
    expect(blocks.match(/<@U/g)).toEqual(["<@U"]);
    expect(blocks).toContain("<@U123>");
    expect(blocks.match(/out-\d+-end/g)).toHaveLength(40);
    expect(blocks).toContain("out-61-end");
    expect(blocks).not.toContain("out-60-end");
  });
});

describe("deploys folded into the push's message", () => {
  const PASSED: RunView = {
    installationId: INSTALLATION,
    repoId: REPO,
    repo: "acme/widgets",
    triggerId: "trg_checks",
    runId: "run_checks",
    sha: SHA,
    shortSha: "aaaaaaa",
    ref: "refs/heads/main",
    event: "push",
    target: "checks",
    state: "success",
    commitTitle: "ship it",
    authorLogin: "alice",
    jobs: [],
  };
  const fold = (deploys: Parameters<typeof renderRunMessage>[1]["deploys"], run: RunView = PASSED) => {
    const msg = renderRunMessage(run, { notify: "normal", deploys });
    return { text: msg.text, blocks: JSON.stringify(msg.blocks) };
  };
  const LOG = "https://hub.test/l/run_p";

  it.each([
    [{ env: "production", sha: SHA, state: "running", step: "build", stepIndex: 1, stepsTotal: 5, logUrl: LOG }, "Deploying production", "production · 2/5 build · <"],
    [{ env: "production", sha: SHA, state: "succeeded", durationMs: 124_000, logUrl: LOG }, "Deployed production", "production · 2m04s · health ok · <"],
    [{ env: "production", sha: SHA, state: "failed", step: "migrate", stepIndex: 2, stepsTotal: 5, rolledBack: true }, "Deploy failed", "production · failed at 3/5 migrate · rolled back"],
    [{ env: "production", sha: SHA, state: "superseded" }, "Passed", "production deploy skipped (newer push)"],
    [{ env: "production", sha: SHA, state: "rejected", reason: "no deploy config" }, "Deploy not started", "production · not started: no deploy config"],
  ] as const)("a %o deploy folds in as its header and line", (s, word, line) => {
    const { text, blocks } = fold([s]);
    expect(text.startsWith(`${word}: acme/widgets aaaaaaa`)).toBe(true);
    expect(blocks).toContain(`*${word}*`);
    expect(blocks).toContain(line);
  });

  it("a failed deploy gets a Retry button with its run and attempt", () => {
    const { blocks } = fold([{ env: "staging", sha: SHA, state: "failed", runId: "run_s", attempt: 2 }]);
    expect(JSON.parse(blocks)).toContainEqual({
      type: "actions",
      elements: [expect.objectContaining({ action_id: RETRY_ACTION, value: "run_s:2", text: expect.objectContaining({ text: S.deploy.retry }) })],
    });
  });

  it("several envs get a line each and the header shows the most active state", () => {
    const { text, blocks } = fold([
      { env: "production", sha: SHA, state: "failed", runId: "run_p", attempt: 1 },
      { env: "qa", sha: SHA, state: "failed", runId: "run_q", attempt: 1 },
      { env: "staging", sha: SHA, state: "running" },
    ]);
    expect(text.startsWith("Deploying staging: ")).toBe(true);
    expect(blocks).toContain("production · failed\\nqa · failed\\nstaging · Running");
    expect(blocks).toContain(S.deploy.retryEnv("production"));
    expect(blocks).toContain(S.deploy.retryEnv("qa"));
  });

  it("a run that has not passed shows no deploys", () => {
    const { text, blocks } = fold([{ env: "staging", sha: SHA, state: "running" }], { ...PASSED, state: "running" });
    expect(text.startsWith("Running: ")).toBe(true);
    expect(blocks).not.toContain("staging ·");
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

  const topPosts = () => calls("/api/chat.postMessage").filter((c) => formField(c.body, "thread_ts") === undefined);
  const replies = () => calls("/api/chat.postMessage").filter((c) => formField(c.body, "thread_ts") !== undefined);
  const texts = (list: FakeCall[]) => list.map((c) => String(formField(c.body, "text")));
  const lastUpdate = () => calls("/api/chat.update").at(-1);

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

  /** Pumps the queue until check holds, then drains it: a deploy's Slack render runs after the agent's frame was answered. */
  async function settle(check: () => void | Promise<void>): Promise<void> {
    await vi.waitFor(
      async () => {
        await after(world, 1000);
        await check();
      },
      { timeout: 4000, interval: 20 },
    );
    await drain();
  }

  const CHECKS_TS = "1699999999.000001";

  /** The push's passed checks run, with its message in the watch's channel. */
  async function checksMessage(): Promise<void> {
    await insertRun(t, {
      run_id: "run_checks",
      repo_id: REPO,
      sha: SHA,
      ref: "refs/heads/main",
      event: "push",
      pr_number: null,
      env: null,
      attempt: 1,
      trigger_id: "trg_checks",
      agent_id: null,
      state: "success",
      reason: null,
      author_login: "alice",
      commit_title: "ship it",
      started_at: 1,
      finished_at: 2,
      duration_ms: 1,
      log_key: null,
    });
    await env.DB.prepare("INSERT INTO slack_messages (run_id, team_id, channel_id, ts) VALUES ('run_checks', ?1, ?2, ?3)").bind(world.team, CHANNEL, CHECKS_TS).run();
  }

  async function linkAlice(): Promise<void> {
    await env.DB.prepare("INSERT INTO user_links (team_id, slack_user_id, github_user_id, github_login, created_at) VALUES (?1, 'U123', 7, 'alice', 1)")
      .bind(world.team)
      .run();
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

  it("a standalone badge posts once, updates, and replies per step and at the end", async () => {
    const socket = await acceptedDeploy();
    await event(socket, { state: "running" });
    await event(socket, { job: "deploy", state: "running", step: "migrate", step_index: 2, steps_total: 8 });
    await settle(() => expect(texts(replies()).some((r) => r.startsWith("Deploying: staging · 3/8 migrate"))).toBe(true));
    await event(socket, { state: "success", duration_ms: 124000 });
    await settle(() => expect(texts(replies()).some((r) => r.startsWith("Deployed: staging · 2m04s · health ok"))).toBe(true));

    const posts = topPosts();
    expect(posts).toHaveLength(1);
    expect(formField(posts[0]?.body, "channel")).toBe(CHANNEL);
    const updates = calls("/api/chat.update");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    for (const update of updates) expect(formField(update.body, "ts")).toBe("1700000000.000001");
    expect(formField(lastUpdate()?.body, "text")).toBe("staging · aaaaaaa · 2m04s · health ok · log");
    expect(blocksOf(lastUpdate())).toContain(`<${stableLogLink(env, RUN, "deploy")}|log>`);
    expect(blocksOf(lastUpdate())).not.toContain("/logs/view?");
    for (const reply of replies()) expect(formField(reply.body, "thread_ts")).toBe("1700000000.000001");
    expect(replies()).toHaveLength(2);
    expect(await getDeployRender(t, RUN)).toMatchObject({ slack_channel: CHANNEL, slack_ts: "1700000000.000001", state: "succeeded" });
  });

  it("a successful deploy's final reply mentions the author, and its step replies do not", async () => {
    await linkAlice();
    const socket = await acceptedDeploy("alice");
    await event(socket, { state: "running" });
    await event(socket, { job: "deploy", state: "running", step: "migrate", step_index: 2, steps_total: 8 });
    await event(socket, { state: "success", duration_ms: 124000 });
    await settle(() => expect(texts(replies()).some((r) => r.startsWith("Deployed: staging"))).toBe(true));
    const mentioned = replies().filter((c) => blocksOf(c).includes("<@U123>"));
    expect(texts(mentioned)).toEqual([expect.stringMatching(/^Deployed: staging · 2m04s · health ok/)]);
    expect(formField(mentioned[0]?.body, "reply_broadcast")).toBeUndefined();
  });

  it("a failed deploy replies once in the thread with the author's mention and the log tail", async () => {
    await linkAlice();
    const socket = await acceptedDeploy("alice");
    await event(socket, { state: "running" });
    await event(socket, { job: "deploy", state: "running", step: "health", step_index: 4, steps_total: 8 });
    await event(socket, { state: "rolling_back" });
    await settle(() => expect(texts(replies()).some((r) => r.startsWith("Deploying: staging · rolling back"))).toBe(true));
    const failures = () => replies().filter((c) => blocksOf(c).includes("<@U123>"));
    expect(failures()).toEqual([]);

    const tail = Array.from({ length: 100 }, (_, i) => `out-${i + 1}-end`);
    await event(socket, { state: "failed", duration_ms: 90000, tail });
    await event(socket, { state: "failed", duration_ms: 90000, tail });
    await settle(() => expect(failures()).toHaveLength(1));

    const failure = failures()[0];
    const blocks = blocksOf(failure);
    expect(blocks.match(/<@U/g)).toEqual(["<@U"]);
    expect(blocks.match(/out-\d+-end/g)).toHaveLength(40);
    expect(blocks).toContain("out-100-end");
    expect(blocks).not.toContain("out-60-end");
    expect(blocks).not.toContain("<!here>");
    expect(formField(failure?.body, "channel")).toBe(CHANNEL);
    expect(formField(failure?.body, "thread_ts")).toBe("1700000000.000001");
    expect(formField(failure?.body, "reply_broadcast")).toBeUndefined();
    expect(String(formField(failure?.body, "text"))).toMatch(/^Deploy failed: acme\/widgets · staging · aaaaaaa · failed at 5\/8 health/);
    expect(topPosts()).toHaveLength(1);
    expect(formField(lastUpdate()?.body, "text")).toBe("staging · aaaaaaa · failed at 5/8 health · rolled back · log");
  });

  it("a failure reply for an author with no Slack user mentions no one", async () => {
    const socket = await acceptedDeploy("bob");
    await event(socket, { state: "running" });
    await event(socket, { state: "failed", tail: ["boom"] });
    await settle(() => expect(texts(replies()).some((r) => r.startsWith("Deploy failed: acme/widgets"))).toBe(true));
    const failure = replies().find((c) => String(formField(c.body, "text")).startsWith("Deploy failed: "));
    expect(blocksOf(failure)).toContain("boom");
    expect(blocksOf(failure)).not.toContain("<@");
  });

  it.each([
    ["interrupted", "interrupted", "cancelled", "Deploy interrupted"],
    ["cancelled", "cancelled", "cancelled", "Deploy cancelled"],
    ["superseded", "superseded by a newer deploy", "neutral", "Deploy superseded"],
  ])("a %s deploy shows its own state, mentions no one and does not fail the check", async (state, text, conclusion, title) => {
    const socket = await acceptedDeploy();
    await event(socket, { state: "running" });
    await event(socket, { state, tail: ["stopped"] });
    await settle(() => expect(formField(lastUpdate()?.body, "text")).toBe(`staging · aaaaaaa · ${text}`));

    expect(topPosts()).toHaveLength(1);
    expect(replies().map(blocksOf).join()).not.toContain("<@");
    expect(calls("/repos/acme/widgets/check-runs/500").at(-1)?.body).toMatchObject({ status: "completed", conclusion, output: { title } });
    expect(await getDeployRender(t, RUN)).toMatchObject({ state });
  });

  it("check run informational", async () => {
    const socket = await acceptedDeploy();
    await event(socket, { state: "running" });
    await event(socket, { job: "deploy", state: "success", duration_ms: 120000 });
    await event(socket, { state: "success", duration_ms: 124000 });

    const created = calls("/repos/acme/widgets/check-runs");
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toMatchObject({ name: "hookci/deploy:staging", head_sha: SHA, status: "in_progress" });
    const updated = calls("/repos/acme/widgets/check-runs/500");
    expect(updated.at(-1)?.body).toMatchObject({
      status: "completed",
      conclusion: "success",
      output: { summary: "staging · aaaaaaa · 2m04s · health ok · log" },
    });
    expect(await getDeployRender(t, RUN)).toMatchObject({ check_run_id: 500 });
    expect(world.slack.calls.filter((c) => new URL(c.url).pathname.includes("/deployments"))).toEqual([]);
    await settle(() => expect(topPosts()).toHaveLength(1));
  });

  /** Sends the accepted deploy a retry as attempt 2 and accepts it under the same run id. */
  async function retried(socket: AgentSocket): Promise<void> {
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
      checksRunId: "run_checks",
    });
    expect(await socket.next()).toMatchObject({ type: "trigger", trigger_id: triggerId, attempt: 2 });
    // The agent resumes the failed run under its own run id.
    expect(await socket.request({ type: "accepted", trigger_id: triggerId, run_id: RUN })).toEqual([]);
  }

  it("a retry that reuses the run id reopens the run, the badge and the check run", async () => {
    const socket = await acceptedDeploy();
    await event(socket, { state: "running" });
    await event(socket, { state: "failed", duration_ms: 90000 });
    await settle(() => expect(blocksOf(lastUpdate())).toContain(`${RUN}:1`));
    expect(await getDeployRender(t, RUN)).toMatchObject({ state: "failed", check_run_id: 500 });

    await retried(socket);
    const runRows = await env.DB.prepare("SELECT run_id, trigger_id, attempt, state, reason, finished_at FROM runs").all();
    expect(runRows.results).toEqual([expect.objectContaining({ run_id: RUN, attempt: 2, state: "queued", reason: null, finished_at: null })]);
    expect(await getDeployRender(t, RUN)).toMatchObject({ state: "queued", check_run_id: null, step: null });

    await event(socket, { state: "running" });
    await event(socket, { state: "failed", duration_ms: 30000 });
    await settle(() => expect(blocksOf(lastUpdate())).toContain(`${RUN}:2`));

    expect(await env.DB.prepare("SELECT state FROM runs WHERE run_id = ?1").bind(RUN).first()).toEqual({ state: "failed" });
    expect(calls("/repos/acme/widgets/check-runs")).toHaveLength(2);
    expect(await getDeployRender(t, RUN)).toMatchObject({ state: "failed", check_run_id: 501, slack_ts: "1700000000.000001" });
    expect(topPosts()).toHaveLength(1);
  });

  it("rejected trigger", async () => {
    const { socket, triggerId } = await deployTrigger();
    await socket.request({ type: "rejected", trigger_id: triggerId, reason: "deployments.staging: not configured" });
    await settle(() => expect(topPosts()).toHaveLength(1));
    expect(formField(topPosts()[0]?.body, "text")).toBe("staging · aaaaaaa · not started: deployments.staging: not configured");
    expect(replies()).toEqual([]);
    expect(calls("/repos/acme/widgets/check-runs")).toEqual([]);
  });

  it("a replayed rejection posts its badge once", async () => {
    const { socket, triggerId } = await deployTrigger();
    const frame = { type: "rejected", trigger_id: triggerId, reason: "deployments.staging: not configured" } as const;
    await socket.request(frame);
    await socket.request(frame);
    await settle(() => expect(topPosts()).toHaveLength(1));
    expect(calls("/api/chat.postMessage")).toHaveLength(1);
  });

  it("sink failure isolated", async () => {
    world.slack.respond("POST", "/api/chat.postMessage", () => new Response("down", { status: 500 }));
    const socket = await pumped(acceptedDeploy());
    await pumped(event(socket, { state: "running" }));
    await pumped(event(socket, { state: "failed" }));
    const run = await env.DB.prepare("SELECT state FROM runs WHERE run_id = ?1").bind(RUN).first<{ state: string }>();
    expect(run?.state).toBe("failed");
    await settle(async () => {
      expect(calls("/api/chat.postMessage").length).toBeGreaterThan(0);
      expect((await queueStats(world)).depth).toBe(0);
    });
    expect(await getDeployRender(t, RUN)).toMatchObject({ state: "failed", slack_ts: null });
  });

  describe("with the push's checks message", () => {
    beforeEach(checksMessage);

    const checksUpdates = () => calls("/api/chat.update").filter((c) => formField(c.body, "ts") === CHECKS_TS);
    const header = () => String(formField(checksUpdates().at(-1)?.body, "text"));

    it("folds the deploy into the checks message and replies in its thread", async () => {
      const socket = await acceptedDeploy();
      await event(socket, { state: "running" });
      await event(socket, { job: "deploy", state: "running", step: "migrate", step_index: 2, steps_total: 8 });
      await settle(() => expect(texts(replies()).some((r) => r.startsWith("Deploying: staging · 3/8 migrate"))).toBe(true));
      expect(header()).toMatch(/^Deploying staging: acme\/widgets aaaaaaa/);
      expect(blocksOf(checksUpdates().at(-1))).toContain("staging · 3/8 migrate");

      await event(socket, { state: "success", duration_ms: 124000 });
      await settle(() => expect(header()).toMatch(/^Deployed staging: /));
      expect(blocksOf(checksUpdates().at(-1))).toContain(`staging · 2m04s · health ok · <${stableLogLink(env, RUN, "deploy")}|log>`);
      expect(texts(replies()).some((r) => r.startsWith("Deployed: staging · 2m04s · health ok"))).toBe(true);
      for (const reply of replies()) expect(formField(reply.body, "thread_ts")).toBe(CHECKS_TS);
      expect(topPosts()).toEqual([]);
      expect(calls("/api/chat.update").filter((c) => formField(c.body, "ts") !== CHECKS_TS)).toEqual([]);
      expect(await getDeployRender(t, RUN)).toMatchObject({ slack_ts: null });
    });

    it("a replayed step event replies once", async () => {
      const socket = await acceptedDeploy();
      const step = { job: "deploy", state: "running", step: "migrate", step_index: 2, steps_total: 8 };
      await event(socket, step);
      await event(socket, step);
      await settle(() => expect(texts(replies()).filter((r) => r.startsWith("Deploying: staging · 3/8 migrate"))).toHaveLength(1));
      await event(socket, step);
      await settle(() => expect(checksUpdates().length).toBeGreaterThan(0));
      expect(texts(replies()).filter((r) => r.startsWith("Deploying: "))).toHaveLength(1);
    });

    it("a failed deploy turns the header to Deploy failed with Retry, and a retry reopens it", async () => {
      await linkAlice();
      const socket = await acceptedDeploy();
      await event(socket, { state: "running" });
      await event(socket, { state: "failed", duration_ms: 90000, tail: ["boom"] });
      const failure = () => replies().find((c) => blocksOf(c).includes("<@U123>"));
      await settle(() => expect(failure()).toBeDefined());
      expect(header()).toMatch(/^Deploy failed: /);
      expect(JSON.parse(blocksOf(checksUpdates().at(-1)))).toContainEqual({
        type: "actions",
        elements: [expect.objectContaining({ action_id: RETRY_ACTION, value: `${RUN}:1` })],
      });
      expect(formField(failure()?.body, "thread_ts")).toBe(CHECKS_TS);
      expect(formField(failure()?.body, "reply_broadcast")).toBeUndefined();
      expect(topPosts()).toEqual([]);

      await retried(socket);
      await event(socket, { state: "running" });
      await settle(() => expect(header()).toMatch(/^Deploying staging: /));
      expect(blocksOf(checksUpdates().at(-1))).not.toContain(RETRY_ACTION);
    });

    it("a dm watch sends the failure to the author with no mention and no thread", async () => {
      await linkAlice();
      await env.DB.prepare("UPDATE watches SET alert = 'dm'").run();
      world.slack.respond("POST", "/api/conversations.open", () => Response.json({ ok: true, channel: { id: "D0ALICE" } }));
      const socket = await acceptedDeploy();
      await event(socket, { state: "running" });
      await event(socket, { state: "failed", tail: ["boom"] });
      const dms = () => calls("/api/chat.postMessage").filter((c) => formField(c.body, "channel") === "D0ALICE");
      await settle(() => expect(dms()).toHaveLength(1));
      expect(texts(dms())[0]).toMatch(/^Deploy failed: /);
      expect(blocksOf(dms()[0])).not.toContain("<@");
      expect(formField(dms()[0]?.body, "thread_ts")).toBeUndefined();
      expect(calls("/api/conversations.open").map((c) => formField(c.body, "users"))).toEqual(["U123"]);
      expect(replies()).toHaveLength(0);
    });

    it("a quiet watch gets no step replies, only the failure", async () => {
      await env.DB.prepare("UPDATE watches SET notify = 'quiet'").run();
      const socket = await acceptedDeploy();
      await event(socket, { job: "deploy", state: "running", step: "migrate", step_index: 2, steps_total: 8 });
      await event(socket, { state: "failed", tail: ["boom"] });
      await settle(() => expect(texts(replies())).toEqual([expect.stringMatching(/^Deploy failed: /)]));
      expect(header()).toMatch(/^Deploy failed: /);
    });

    it("a superseded deploy leaves the header Passed with a skipped line", async () => {
      const socket = await acceptedDeploy();
      await event(socket, { state: "running" });
      await event(socket, { state: "superseded" });
      await settle(() => expect(header()).toMatch(/^Passed: /));
      expect(blocksOf(checksUpdates().at(-1))).toContain("staging deploy skipped (newer push)");
    });

    it("a rejected trigger shows Deploy not started with its reason", async () => {
      const { socket, triggerId } = await deployTrigger();
      await socket.request({ type: "rejected", trigger_id: triggerId, reason: "not configured" });
      await settle(() => expect(header()).toMatch(/^Deploy not started: /));
      expect(blocksOf(checksUpdates().at(-1))).toContain("staging · not started: not configured");
      expect(topPosts()).toEqual([]);
    });

    it("the same sha pushed to another branch: the deploy folds into the message of the run that chained it", async () => {
      const RELEASE_TS = "1699999999.000009";
      await insertRun(t, {
        run_id: "run_release",
        repo_id: REPO,
        sha: SHA,
        ref: "refs/heads/release",
        event: "push",
        pr_number: null,
        env: null,
        attempt: 1,
        trigger_id: "trg_release",
        agent_id: null,
        state: "success",
        reason: null,
        author_login: "alice",
        commit_title: "ship it",
        started_at: 3,
        finished_at: 4,
        duration_ms: 1,
        log_key: null,
      });
      await env.DB.prepare("INSERT INTO slack_messages (run_id, team_id, channel_id, ts) VALUES ('run_release', ?1, ?2, ?3)").bind(world.team, CHANNEL, RELEASE_TS).run();

      const socket = await acceptedDeploy();
      await event(socket, { state: "running" });
      await settle(() => expect(header()).toMatch(/^Deploying staging: acme\/widgets aaaaaaa/));
      expect(calls("/api/chat.update").filter((c) => formField(c.body, "ts") === RELEASE_TS)).toEqual([]);
      for (const reply of replies()) expect(formField(reply.body, "thread_ts")).toBe(CHECKS_TS);
    });

    it("a deploy on another agent renders through the queue of the agent that ran the checks", async () => {
      const owner = await seedAgent(INSTALLATION);
      await env.DB.prepare("UPDATE runs SET agent_id = ?1 WHERE run_id = 'run_checks'").bind(owner.agentId).run();
      // Holds the owner's queue for the checks message, as a render of the checks run in flight would.
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await runInDurableObject(owner.stub, (dob) => {
        const host = { agentId: owner.agentId, storage: dob.state.storage, now: () => Date.now() };
        void slackSinkFactory(env, INSTALLATION, host).inOrder("trg_checks", () => held);
      });

      const socket = await acceptedDeploy();
      await event(socket, { state: "running" });
      await event(socket, { state: "success", duration_ms: 124000 });
      for (let i = 0; i < 3; i++) await after(world, 1000);
      expect(checksUpdates()).toEqual([]);

      release();
      await settle(() => expect(header()).toMatch(/^Deployed staging: /));
      expect(blocksOf(checksUpdates().at(-1))).toContain("staging · 2m04s · health ok");
      expect(topPosts()).toEqual([]);
    });
  });

  /** Connects an agent bound to checks and deploy:staging and runs the push's checks run to running. */
  async function runningPush(): Promise<AgentSocket> {
    const agent = await seedAgent(INSTALLATION);
    await bind(t, REPO, "checks", agent.agentId);
    await bind(t, REPO, "deploy:staging", agent.agentId);
    const socket = await connect(agent);
    sock = socket;
    expect(await socket.hello()).toMatchObject({ type: "welcome" });
    const res = await agent.stub.fetch("https://do/trigger", {
      method: "POST",
      headers: { "x-hookci-agent-id": agent.agentId },
      body: JSON.stringify({
        installationId: INSTALLATION,
        repoId: REPO,
        repo: "acme/widgets",
        sha: SHA,
        ref: "refs/heads/main",
        event: "push",
        authorLogin: "alice",
        commitTitle: "ship it",
        defaultBranch: "main",
        target: "checks",
        trust: "trusted",
      } satisfies TriggerRequest),
    });
    expect(res.status).toBe(202);
    const { trigger_id } = await res.json<{ trigger_id: string }>();
    expect(await socket.next()).toMatchObject({ type: "trigger", trigger_id });
    await settle(() => expect(topPosts()).toHaveLength(1));
    await pumped(socket.request({ type: "accepted", trigger_id, run_id: "run_push" }));
    await pumped(socket.request({ type: "event", agent_seq: ++agentSeq, run_id: "run_push", state: "running" }));
    return socket;
  }

  it("a passing push never shows Passed before its deploy was sent", async () => {
    const socket = await runningPush();
    // The deploy trigger goes out while the success frame is handled, before the run's state is written.
    const sent = await pumped(socket.request({ type: "event", agent_seq: ++agentSeq, run_id: "run_push", state: "success", duration_ms: 1000 }));
    expect(sent).toContainEqual(expect.objectContaining({ type: "trigger", env: "staging" }));
    await settle(() => expect(texts(calls("/api/chat.update")).at(-1)).toMatch(/^Deploying staging: /));

    const rendered = texts([...calls("/api/chat.postMessage"), ...calls("/api/chat.update")]);
    expect(rendered.filter((text) => text.startsWith("Passed: "))).toEqual([]);
    expect(topPosts()).toHaveLength(1);
  });

  it("a checks run D1 already ended chains no deploy on a late success frame", async () => {
    const socket = await runningPush();
    await env.DB.prepare("UPDATE runs SET state = 'superseded', finished_at = 2 WHERE run_id = 'run_push'").run();
    const sent = await pumped(socket.request({ type: "event", agent_seq: ++agentSeq, run_id: "run_push", state: "success", duration_ms: 1000 }));
    expect(sent).not.toContainEqual(expect.objectContaining({ type: "trigger" }));
    expect((await env.DB.prepare("SELECT trigger_id FROM deploy_triggers").all()).results).toEqual([]);
    await drain();
  });
});
