import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertInstallation } from "../../src/db/installations";
import { acceptRun, insertRun, type NewRun, updateRunState, upsertJob } from "../../src/db/runs";
import { upsertRepos } from "../../src/db/repos";
import { getSlackMessage } from "../../src/db/slack-messages";
import { tenantDb } from "../../src/db/tenant";
import { addWatch, listWatchesForRepo, type NewWatch } from "../../src/db/watches";
import { clearOfflineDm } from "../../src/do/agent-hooks";
import { verifyLogSig } from "../../src/logs/sign";
import { slackApi, slackApiFireAndForget } from "../../src/slack/api";
import { resetChannelCacheForTests } from "../../src/slack/channels";
import { type SlackSink, slackSinkFactory } from "../../src/sinks/slack";
import type { JobView, RunView } from "../../src/sinks/types";
import { S } from "../../src/strings";
import { clearTables } from "../db/helpers";
import { type Agent, seedAgent } from "../do/agent-socket";
import { after, formField, queueStats, useQueueWorld } from "../do/slack-queue-world";
import type { FakeCall } from "../fakes/http";
import { FORBIDDEN_SLACK_METHODS } from "../fakes/slack";
import { gzip, numberedLines } from "../logs/helpers";

const INSTALLATION = 77;
const REPO = 2002;
const CHANNEL = "C0WATCH";
const CREATOR = "U0CREATOR";
const SHA = "2".repeat(40);
const SHORT = SHA.slice(0, 7);
const t = tenantDb(env.DB, INSTALLATION);

const RUN_ROW: NewRun = {
  run_id: "run_1",
  repo_id: REPO,
  sha: SHA,
  ref: "refs/heads/main",
  event: "push",
  pr_number: null,
  env: null,
  attempt: 1,
  trigger_id: "trg_1",
  agent_id: null,
  state: "running",
  reason: null,
  author_login: "alice",
  commit_title: "Add widget sizing",
  started_at: 1,
  finished_at: null,
  duration_ms: null,
  log_key: null,
};

function runView(over: Partial<RunView> = {}): RunView {
  return {
    installationId: INSTALLATION,
    repoId: REPO,
    repo: "acme/widgets",
    triggerId: "trg_1",
    runId: "run_1",
    sha: SHA,
    shortSha: SHORT,
    ref: "refs/heads/main",
    event: "push",
    target: "checks",
    state: "running",
    commitTitle: "Add widget sizing",
    authorLogin: "alice",
    jobs: [],
    ...over,
  };
}

/** Tables are cleared before the queue world seeds its workspace. */
beforeEach(clearTables);
const world = useQueueWorld();

function apiCalls(method: string): FakeCall[] {
  return world.slack.calls.filter((call) => new URL(call.url).pathname === `/api/${method}`);
}

function text(call: FakeCall | undefined): string {
  return String(formField(call?.body, "text"));
}

/** The calls to method that went to channel. */
function inChannel(method: string, channel: string): FakeCall[] {
  return apiCalls(method).filter((call) => formField(call.body, "channel") === channel);
}

/** Runs the queue's alarms until every fire-and-forget call went out. */
async function drain(): Promise<void> {
  for (let i = 0; i < 30 && (await queueStats(world)).depth > 0; i++) await after(world, 1000);
  expect((await queueStats(world)).depth).toBe(0);
}

async function watch(over: Partial<NewWatch> = {}): Promise<void> {
  await addWatch(t, { repo_id: REPO, team_id: world.team, channel_id: CHANNEL, notify: "normal", alert: "channel", created_by: CREATOR, ...over });
}

async function mapAuthor(login: string, slackUserId: string): Promise<void> {
  await env.DB.prepare("INSERT INTO author_map (installation_id, team_id, github_login, slack_user_id) VALUES (?1, ?2, ?3, ?4)")
    .bind(INSTALLATION, world.team, login, slackUserId)
    .run();
}

/** Runs fn with the sink an AgentDO's fan-out builds, on the DO's storage. */
async function inAgent(agent: Agent, fn: (sink: SlackSink, storage: DurableObjectStorage) => Promise<void>): Promise<void> {
  await runInDurableObject(agent.stub, (dob) =>
    fn(slackSinkFactory(dob.bindings, INSTALLATION, { storage: dob.state.storage, now: () => dob.clock.now() }), dob.state.storage),
  );
}

/** Holds the workspace's queue for seconds: the first chat.update answers 429, later ones succeed. */
async function holdQueue(seconds: number): Promise<void> {
  let held = false;
  world.slack.respond("POST", "/api/chat.update", ({ body }) => {
    if (held) return Response.json({ ok: true, ts: formField(body, "ts") });
    held = true;
    return new Response("", { status: 429, headers: { "retry-after": String(seconds) } });
  });
  await slackApiFireAndForget(env, world.team, "chat.update", { channel: CHANNEL, ts: "0.0", text: "hold" });
  await vi.waitFor(async () => expect((await queueStats(world)).rate_limited_total).toBe(1));
}

/** The ts stored for job's thread reply in the watched channel. */
async function replyTs(job: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT ts FROM slack_job_replies WHERE run_id = 'run_1' AND channel_id = ?1 AND job = ?2").bind(CHANNEL, job).first<{ ts: string }>();
  return row?.ts;
}

describe("SlackSink", () => {
  let nextTs: number;

  beforeEach(async () => {
    await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", account_id: INSTALLATION * 10, created_at: 1 });
    await insertRun(t, RUN_ROW);
    nextTs = 1;
    world.slack.respond("POST", "/api/chat.postMessage", ({ body }) => {
      world.clock.advance(1000);
      return Response.json({ ok: true, channel: formField(body, "channel"), ts: `1700000000.${String(nextTs++).padStart(6, "0")}` });
    });
    world.slack.respond("POST", "/api/chat.update", ({ body }) => Response.json({ ok: true, ts: formField(body, "ts") }));
    world.slack.respond("POST", "/api/conversations.open", ({ body }) =>
      Response.json({ ok: true, channel: { id: `D${String(formField(body, "users")).slice(1)}` } }),
    );
    world.slack.respond("POST", "/api/users.lookupByEmail", () => Response.json({ ok: false, error: "users_not_found" }));
  });

  afterEach(() => {
    expect(world.slack.calls.filter((call) => FORBIDDEN_SLACK_METHODS.some((m) => call.url.endsWith(`/api/${m}`)))).toEqual([]);
  });

  it("posts once, then updates in place until the run passes", async () => {
    await watch();
    const sink = slackSinkFactory(env, INSTALLATION);
    const jobs: JobView[] = [{ name: "test", state: "running" }];
    await sink.onRunUpdate(runView({ state: "received", jobs: [] }));
    await sink.onRunUpdate(runView({ state: "queued", jobs: [] }));
    for (let i = 1; i <= 3; i++) {
      const job: JobView = { name: "test", state: "running", step: `step ${i}`, stepIndex: i, stepsTotal: 3 };
      await sink.onJobUpdate(runView({ jobs: [job], currentJob: "test" }), job);
    }
    await sink.onRunUpdate(runView({ state: "success", jobs: jobs.map((j) => ({ ...j, state: "success" })), durationMs: 42_000 }));
    await drain();

    expect(apiCalls("chat.postMessage")).toHaveLength(1);
    expect(text(apiCalls("chat.postMessage")[0])).toMatch(/^Waiting: /);
    const updates = apiCalls("chat.update");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.every((call) => formField(call.body, "ts") === "1700000000.000001")).toBe(true);
    expect(text(updates.at(-1))).toMatch(/^Passed: acme\/widgets 2222222 on main/);
  });

  it("posts once when two sinks race on the run's first update", async () => {
    await watch();
    const run = runView({ state: "received" });
    await Promise.all([slackSinkFactory(env, INSTALLATION).onRunUpdate(run), slackSinkFactory(env, INSTALLATION).onRunUpdate(run)]);
    await drain();

    expect(apiCalls("chat.postMessage")).toHaveLength(1);
    expect(apiCalls("chat.update")).toHaveLength(1);
    expect(await getSlackMessage(t, "run_1", world.team, CHANNEL)).toMatchObject({ ts: "1700000000.000001" });
  });

  it("keeps the trigger's message once the agent accepts the run under its own id", async () => {
    await watch();
    await insertRun(t, { ...RUN_ROW, run_id: "trg_2", trigger_id: "trg_2", state: "received" });
    const sink = slackSinkFactory(env, INSTALLATION);
    await sink.onRunUpdate(runView({ triggerId: "trg_2", runId: undefined, state: "received" }));
    expect(await acceptRun(t, "trg_2", "run_2", "agt_1")).toBe(true);
    await sink.onRunUpdate(runView({ triggerId: "trg_2", runId: "run_2", state: "running" }));
    await drain();

    expect(apiCalls("chat.postMessage")).toHaveLength(1);
    expect(text(apiCalls("chat.update").at(-1))).toMatch(/^Running: /);
    expect(await getSlackMessage(t, "run_2", world.team, CHANNEL)).toMatchObject({ ts: "1700000000.000001" });
  });

  it("posts a run's first message held in the queue past 10 s once, then brings it up to what the run did meanwhile", async () => {
    await watch();
    await upsertRepos(t, [{ repo_id: REPO, full_name: "acme/widgets", default_branch: "main" }]);
    await holdQueue(30);
    const sink = slackSinkFactory(env, INSTALLATION);
    const first = sink.onRunUpdate(runView({ state: "running" }));
    await vi.waitFor(async () => expect((await queueStats(world)).depth).toBe(2));
    await after(world, 10_000);
    await first;
    expect(apiCalls("chat.postMessage")).toEqual([]);

    // The run passes while its first post waits.
    await upsertJob(t, { run_id: "run_1", name: "test", state: "success", step: null, step_index: null, steps_total: null, duration_ms: 1500 });
    expect(await updateRunState(t, "run_1", "success")).toBe(true);
    await after(world, 20_000);
    await vi.waitFor(async () => {
      await after(world, 1000);
      expect(apiCalls("chat.postMessage").map(text)).toEqual([
        expect.stringMatching(/^Running: /),
        S.slack.jobReplyText("Passed", "test", "acme/widgets", SHORT),
      ]);
      expect(text(apiCalls("chat.update").at(-1))).toMatch(/^Passed: acme\/widgets/);
    });
    expect(await getSlackMessage(t, "run_1", world.team, CHANNEL)).toMatchObject({ ts: "1700000000.000001" });
    expect(await replyTs("test")).toBe("1700000000.000002");

    await sink.onJobUpdate(runView({ state: "success", jobs: [{ name: "test", state: "success" }] }), { name: "test", state: "success" });
    await drain();
    expect(apiCalls("chat.postMessage")).toHaveLength(2);
  });

  it("posts a job's thread reply held in the queue past 10 s once and keeps its ts", async () => {
    await watch();
    const sink = slackSinkFactory(env, INSTALLATION);
    await sink.onRunUpdate(runView({ state: "running" }));
    await holdQueue(30);
    const job: JobView = { name: "test", state: "success" };
    const replying = sink.onJobUpdate(runView({ jobs: [job] }), job);
    await vi.waitFor(async () => expect((await queueStats(world)).depth).toBe(3));
    await after(world, 10_000);
    await replying;
    await sink.onJobUpdate(runView({ jobs: [job] }), job);

    await after(world, 20_000);
    await drain();
    const [, ...replies] = apiCalls("chat.postMessage");
    expect(replies.map(text)).toEqual([S.slack.jobReplyText("Passed", "test", "acme/widgets", SHORT)]);
    expect(formField(replies[0]?.body, "thread_ts")).toBe("1700000000.000001");
    await vi.waitFor(async () => expect(await replyTs("test")).toBe("1700000000.000002"));
  });

  it("replies once per finished job in the thread on a normal watch", async () => {
    await watch();
    const sink = slackSinkFactory(env, INSTALLATION);
    const names = ["lint", "test", "build"];
    await sink.onJobPlanned(runView({ jobs: names.map((name) => ({ name, state: "queued" })) }));
    for (const name of names) {
      const job: JobView = { name, state: "success", durationMs: 1500 };
      await sink.onJobUpdate(runView(), { name, state: "running" });
      await sink.onJobUpdate(runView({ jobs: [job] }), job);
    }
    await sink.onJobUpdate(runView(), { name: "lint", state: "success" });

    const [parent, ...replies] = apiCalls("chat.postMessage");
    expect(replies).toHaveLength(3);
    for (const reply of replies) expect(formField(reply.body, "thread_ts")).toBe("1700000000.000001");
    expect(replies.map(text)).toEqual(names.map((name) => S.slack.jobReplyText("Passed", name, "acme/widgets", SHORT)));
    expect(formField(parent?.body, "thread_ts")).toBeUndefined();
  });

  it("posts no thread replies on a quiet watch and lists job results in the message", async () => {
    await watch({ notify: "quiet" });
    const sink = slackSinkFactory(env, INSTALLATION);
    const jobs: JobView[] = ["lint", "test", "build"].map((name) => ({ name, state: "success" }));
    for (const job of jobs) await sink.onJobUpdate(runView({ jobs }), job);
    await drain();

    expect(apiCalls("chat.postMessage")).toHaveLength(1);
    expect(String(formField(apiCalls("chat.update").at(-1)?.body, "blocks"))).toContain("build: Passed");
  });

  it("alerts once on a failed run with the job's last 40 log lines and one mention", async () => {
    await watch();
    await mapAuthor("alice", "U0ALICE");
    const agent = await seedAgent(INSTALLATION);
    const failed: JobView = { name: "build", state: "failed", step: "make", tail: Array.from({ length: 60 }, (_, i) => `line ${i}`) };
    await inAgent(agent, async (sink) => {
      await sink.onJobUpdate(runView({ jobs: [failed] }), failed);
      await sink.onRunUpdate(runView({ state: "failed", jobs: [failed] }));
      await sink.onRunUpdate(runView({ state: "failed", jobs: [failed] }));
      await sink.onJobUpdate(runView({ state: "failed", jobs: [failed] }), failed);
    });

    const alertText = S.slack.alertText("Failed", "acme/widgets", SHORT, "build");
    const alerts = apiCalls("chat.postMessage").filter((call) => text(call) === alertText);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(formField(alert.body, "thread_ts")).toBe("1700000000.000001");
    const blocks = String(formField(alert.body, "blocks"));
    expect(blocks.match(/<@U/g)).toEqual(["<@U"]);
    expect(blocks).toContain("<@U0ALICE>");
    const fenced = /```\\n(.*?)\\n```/.exec(blocks)?.[1]?.split("\\n") ?? [];
    expect(fenced).toHaveLength(40);
    expect(fenced[0]).toBe("line 20");
    expect(fenced.at(-1)).toBe("line 59");
    expect((await getSlackMessage(t, "run_1", world.team, CHANNEL))?.alert_ts).toBe("1700000000.000003");
  });

  it("alerts with the uploaded log's last 40 lines, a signed log link and a View log button", async () => {
    await watch();
    await env.LOGS.put(`logs/${INSTALLATION}/run_1/build.log.gz`, await gzip(numberedLines(100)));
    const agent = await seedAgent(INSTALLATION);
    const failed: JobView = { name: "build", state: "failed", step: "make", tail: ["agent tail"] };
    await inAgent(agent, async (sink) => {
      await sink.onJobUpdate(runView({ jobs: [failed] }), failed);
      await sink.onRunUpdate(runView({ state: "failed", jobs: [failed] }));
    });
    await env.LOGS.delete(`logs/${INSTALLATION}/run_1/build.log.gz`);

    const alert = apiCalls("chat.postMessage").find((call) => text(call) === S.slack.alertText("Failed", "acme/widgets", SHORT, "build"));
    const blocks = String(formField(alert?.body, "blocks"));
    const fenced = /```\\n(.*?)\\n```/.exec(blocks)?.[1]?.split("\\n") ?? [];
    expect(fenced).toEqual(Array.from({ length: 40 }, (_, i) => `line ${61 + i}`));
    expect(blocks).not.toContain("agent tail");
    const url = new URL(/<(https:[^|>]+\/logs\/[^|>]+)\|/.exec(blocks)?.[1] ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(`${env.HUB_ORIGIN}/logs/run_1/build`);
    expect(await verifyLogSig(env, "run_1", "build", Number(url.searchParams.get("exp")), url.searchParams.get("sig") ?? "", world.clock.now())).toBe(true);
    expect(JSON.parse(blocks)).toContainEqual({
      type: "actions",
      elements: [expect.objectContaining({ type: "button", action_id: "log:view", value: "run_1:build", text: expect.objectContaining({ text: S.slack.viewLog }) })],
    });
  });

  it("alerts on a job whose logs stay on the agent with the logs: local note and no tail or button", async () => {
    await watch();
    const agent = await seedAgent(INSTALLATION);
    const failed: JobView = { name: "build", state: "failed", step: "make", logs: "local" };
    await inAgent(agent, async (sink) => {
      await sink.onJobUpdate(runView({ jobs: [failed] }), failed);
      await sink.onRunUpdate(runView({ state: "failed", jobs: [{ name: "build", state: "failed", step: "make" }] }));
    });

    const alert = apiCalls("chat.postMessage").find((call) => text(call) === S.slack.alertText("Failed", "acme/widgets", SHORT, "build"));
    const blocks = JSON.parse(String(formField(alert?.body, "blocks")));
    expect(blocks).toContainEqual({ type: "context", elements: [{ type: "mrkdwn", text: S.slack.logsLocal }] });
    expect(JSON.stringify(blocks)).not.toContain("log:view");
    expect(JSON.stringify(blocks)).not.toContain("```");
  });

  it("sends a dm alert to the author through conversations.open", async () => {
    await watch({ alert: "dm" });
    await mapAuthor("alice", "U0ALICE");
    const failed: JobView = { name: "build", state: "failed" };
    await slackSinkFactory(env, INSTALLATION).onRunUpdate(runView({ state: "failed", jobs: [failed] }));

    expect(apiCalls("conversations.open").map((call) => formField(call.body, "users"))).toEqual(["U0ALICE"]);
    const dm = inChannel("chat.postMessage", "D0ALICE");
    expect(dm).toHaveLength(1);
    expect(formField(dm[0]?.body, "thread_ts")).toBeUndefined();
    expect(text(dm[0])).toMatch(/^Failed: /);
  });

  it("puts a dm alert for an unknown author in the channel thread without a mention", async () => {
    await watch({ alert: "dm" });
    const failed: JobView = { name: "build", state: "failed" };
    await slackSinkFactory(env, INSTALLATION).onRunUpdate(runView({ state: "failed", authorLogin: "bob", jobs: [failed] }));

    expect(apiCalls("conversations.open")).toEqual([]);
    const posts = inChannel("chat.postMessage", CHANNEL);
    expect(posts).toHaveLength(2);
    expect(formField(posts[1]?.body, "thread_ts")).toBe("1700000000.000001");
    expect(String(formField(posts[1]?.body, "blocks"))).not.toContain("<@");
  });

  it("stops posting to a channel Slack reports gone and tells the watch's creator once", async () => {
    await watch();
    world.slack.respond("POST", "/api/chat.postMessage", ({ body }) => {
      world.clock.advance(1000);
      if (formField(body, "channel") === CHANNEL) return Response.json({ ok: false, error: "channel_not_found" });
      return Response.json({ ok: true, ts: `1700000000.${String(nextTs++).padStart(6, "0")}` });
    });
    const sink = slackSinkFactory(env, INSTALLATION);
    await sink.onRunUpdate(runView({ state: "received" }));
    await sink.onRunUpdate(runView({ state: "running" }));
    await sink.onRunUpdate(runView({ state: "failed", jobs: [{ name: "build", state: "failed" }] }));
    await drain();

    expect(world.slack.calls.filter((call) => formField(call.body, "channel") === CHANNEL)).toHaveLength(1);
    expect(await listWatchesForRepo(t, REPO)).toEqual([expect.objectContaining({ status: "broken", broken_reason: "channel_not_found" })]);
    await vi.waitFor(() => expect(inChannel("chat.postMessage", CREATOR).map(text)).toEqual([S.slack.watchBroken(CHANNEL, "channel_not_found")]));
  });

  it("breaks the watch when an in-place update finds the channel archived", async () => {
    await watch();
    const sink = slackSinkFactory(env, INSTALLATION);
    await sink.onRunUpdate(runView({ state: "received" }));
    world.slack.respond("POST", "/api/chat.update", () => Response.json({ ok: false, error: "is_archived" }));
    await sink.onRunUpdate(runView({ state: "running" }));
    await drain();
    await vi.waitFor(() => expect(inChannel("chat.postMessage", CREATOR).map(text)).toEqual([S.slack.watchBroken(CHANNEL, "is_archived")]));

    await sink.onRunUpdate(runView({ state: "success" }));
    await drain();
    expect(apiCalls("chat.update")).toHaveLength(1);
    expect(await listWatchesForRepo(t, REPO)).toEqual([expect.objectContaining({ status: "broken", broken_reason: "is_archived" })]);
  });

  it("marks waiting runs agent offline and DMs the agent's admin once per episode", async () => {
    await watch();
    const agent = await seedAgent(INSTALLATION);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO workspace_links (team_id, installation_id, linked_by, created_at) VALUES (?1, ?2, 'U0ADMIN', 1)").bind(world.team, INSTALLATION),
      env.DB.prepare("INSERT INTO user_links (team_id, slack_user_id, github_user_id, github_login, created_at) VALUES (?1, 'U0ADMIN', 7, 'admin', 1)").bind(world.team),
    ]);
    const queued = runView({ state: "queued" });
    const view = { agentId: agent.agentId, installationId: INSTALLATION, name: "builder", lastSeenAt: 1_700_000_000_000 };
    await inAgent(agent, async (sink, storage) => {
      await sink.onRunUpdate(queued);
      await sink.onAgentOffline(view, [queued]);
      await sink.onAgentOffline(view, [queued]);
      await drain();
      expect(text(apiCalls("chat.update").at(-1))).toMatch(/^Agent offline: acme\/widgets/);
      expect(inChannel("chat.postMessage", "U0ADMIN").map(text)).toEqual([S.slack.offlineDmText("Agent offline", "builder", 1)]);

      // The agent's hello ends the episode; the next disconnect DMs again.
      clearOfflineDm(storage);
      await sink.onAgentOffline(view, [queued]);
    });
    expect(inChannel("chat.postMessage", "U0ADMIN")).toHaveLength(2);
  });

  it("never reads channel history: the fake Slack refuses it", async () => {
    world.slack.respond("POST", /^\/api\//, () => Response.json({ ok: true, messages: [] }));
    await expect(slackApi(env, world.team, "conversations.history", { channel: CHANNEL })).rejects.toMatchObject({ message: "missing_scope" });
    // This test made the forbidden call on purpose; the afterEach check is for the sink.
    world.slack.calls.length = 0;
  });

  describe("with a .zeroci.yml notify.slack override", () => {
    const DEPLOYS = "C0DEPLOYS";
    const slack: RunView["slack"] = { channel: "deploys", notify: "quiet", alert: "dm" };

    /** conversations.list answers in two pages: general, then deploys with the bot in it unless told otherwise. */
    function listChannels(deploys: { name: string; is_member: boolean } = { name: "deploys", is_member: true }): void {
      world.slack.respond("POST", "/api/conversations.list", ({ body }) =>
        formField(body, "cursor") === "page2"
          ? Response.json({ ok: true, channels: [{ id: DEPLOYS, ...deploys }], response_metadata: { next_cursor: "" } })
          : Response.json({ ok: true, channels: [{ id: "C0GENERAL", name: "general", is_member: true }], response_metadata: { next_cursor: "page2" } }),
      );
    }

    beforeEach(resetChannelCacheForTests);
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("posts in the named channel with the override's notify and alert over the watch's", async () => {
      listChannels();
      await watch({ notify: "normal", alert: "channel" });
      await mapAuthor("alice", "U0ALICE");
      const sink = slackSinkFactory(env, INSTALLATION);
      const lint: JobView = { name: "lint", state: "success" };
      await sink.onJobUpdate(runView({ slack, jobs: [lint] }), lint);
      const failed: JobView = { name: "build", state: "failed" };
      await sink.onRunUpdate(runView({ slack, state: "failed", jobs: [lint, failed] }));
      await drain();

      expect(world.slack.calls.filter((call) => formField(call.body, "channel") === CHANNEL)).toEqual([]);
      const posts = inChannel("chat.postMessage", DEPLOYS);
      expect(posts).toHaveLength(1);
      expect(formField(posts[0]?.body, "thread_ts")).toBeUndefined();
      expect(apiCalls("conversations.open").map((call) => formField(call.body, "users"))).toEqual(["U0ALICE"]);
      expect(text(inChannel("chat.postMessage", "D0ALICE")[0])).toMatch(/^Failed: /);
      expect(apiCalls("conversations.list")).toHaveLength(2);
    });

    it("keeps the watch's notify and alert where the override sets none", async () => {
      listChannels();
      await watch({ notify: "normal", alert: "channel" });
      const sink = slackSinkFactory(env, INSTALLATION);
      const lint: JobView = { name: "lint", state: "success" };
      await sink.onJobUpdate(runView({ slack: { channel: "deploys" }, jobs: [lint] }), lint);

      const [parent, reply] = inChannel("chat.postMessage", DEPLOYS);
      expect(formField(parent?.body, "thread_ts")).toBeUndefined();
      expect(formField(reply?.body, "thread_ts")).toBe("1700000000.000001");
    });

    it("keeps updating the message the watch channel got before the agent sent the override", async () => {
      listChannels();
      await watch();
      const sink = slackSinkFactory(env, INSTALLATION);
      await sink.onRunUpdate(runView({ state: "received" }));
      await sink.onRunUpdate(runView({ slack, state: "running" }));
      await sink.onRunUpdate(runView({ slack, state: "success", jobs: [{ name: "lint", state: "success" }] }));
      await drain();

      expect(inChannel("chat.postMessage", CHANNEL)).toHaveLength(1);
      expect(text(inChannel("chat.update", CHANNEL).at(-1))).toMatch(/^Passed: /);
      expect(inChannel("chat.postMessage", DEPLOYS)).toHaveLength(1);
      expect(text(inChannel("chat.update", DEPLOYS).at(-1))).toMatch(/^Passed: /);
    });

    it.each([
      { reason: "not_member", deploys: { name: "deploys", is_member: false } },
      { reason: "not_found", deploys: { name: "releases", is_member: true } },
    ])("falls back to the watch when the bot cannot post in the named channel ($reason) and logs it once", async ({ reason, deploys }) => {
      listChannels(deploys);
      await watch({ notify: "quiet" });
      const log = vi.spyOn(console, "log");
      const sink = slackSinkFactory(env, INSTALLATION);
      await sink.onRunUpdate(runView({ slack, state: "running" }));
      await sink.onRunUpdate(runView({ slack, state: "success" }));
      await drain();

      expect(inChannel("chat.postMessage", CHANNEL)).toHaveLength(1);
      expect(inChannel("chat.postMessage", DEPLOYS)).toEqual([]);
      const unresolved = log.mock.calls.filter(([line]) => String(line).includes('"event":"slack_override_unresolved"'));
      expect(unresolved.map(([line]) => JSON.parse(String(line)))).toEqual([
        expect.objectContaining({ team_id: world.team, channel: "deploys", reason }),
      ]);
    });
  });
});
