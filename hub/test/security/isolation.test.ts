// Two tenants, A and B, seeded side by side. A holds every credential it
// legitimately owns (agent credential, pair token, Slack workspace, GitHub
// admin login) and aims each one at B's runs, repo, agent, approval and logs.
// Every attempt must be refused, logged as tenant_denied and leave B's rows
// and log bytes as they were.

import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { base64url, hex, hmacSha256 } from "../../src/crypto";
import { purgeInstallation } from "../../src/db/installations";
import type { HubTrigger } from "../../src/github/normalize";
import { resetPermissionCacheForTests } from "../../src/github/permission-cache";
import type { PullRequest } from "../../src/github/types";
import worker from "../../src/index";
import { signLogUrl } from "../../src/logs/signing";
import { escapeHtml } from "../../src/pages/layout";
import { S } from "../../src/strings";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { connect } from "../do/agent-socket";
import { createFakeGitHub, serveInstallationTokens } from "../fakes/github";
import type { FakeService } from "../fakes/http";
import { createFakeSlack } from "../fakes/slack";
import { generateAppKey } from "../github/helpers";
import { seedTenant, TENANT_TABLES, type Tenant, tenantRowCounts, tenantRows } from "../helpers/tenants";
import { gzip } from "../logs/helpers";

let a: Tenant;
let b: Tenant;
let gh: FakeService;
let slack: FakeService;
let log: MockInstance<typeof console.log>;
let appKey: string | undefined;
let gates = 0;
const saved = { fetcher: env.__TEST_FETCHER, key: env.GITHUB_APP_PRIVATE_KEY };

beforeEach(async () => {
  await clearTables();
  resetPermissionCacheForTests();
  a = await seedTenant(env, { installationId: 701, teamId: "T0TENANTA" });
  b = await seedTenant(env, { installationId: 702, teamId: "T0TENANTB" });

  appKey ??= (await generateAppKey()).pem;
  env.GITHUB_APP_PRIVATE_KEY = appKey;
  gh = createFakeGitHub();
  serveInstallationTokens(gh, testClock.now());
  // GitHub vouches for everyone as admin, so only the hub's tenant checks stand between A and B.
  gh.respond("GET", "/orgs/:org/memberships/:login", () => Response.json({ state: "active", role: "admin" }));
  gh.respond("GET", "/repos/:owner/:repo/collaborators/:login/permission", () => Response.json({ permission: "admin" }));
  slack = createFakeSlack();
  slack.respond("POST", /^\/(commands|actions)\//, () => new Response("ok"));
  env.__TEST_FETCHER = (input, init) => {
    const host = new URL(input instanceof Request ? input.url : input).hostname;
    return (host === "hooks.slack.com" || host === "slack.com" ? slack : gh).fetcher(input, init);
  };
  log = vi.spyOn(console, "log");
});

afterEach(() => {
  env.__TEST_FETCHER = saved.fetcher;
  env.GITHUB_APP_PRIVATE_KEY = saved.key;
  vi.restoreAllMocks();
});

/** The tenant_denied events logged so far in this test. */
function denials(): object[] {
  return log.mock.calls.flatMap(([line]) => {
    if (typeof line !== "string" || !line.startsWith("{")) return [];
    const entry: unknown = JSON.parse(line);
    return typeof entry === "object" && entry !== null && "event" in entry && entry.event === "tenant_denied" ? [entry] : [];
  });
}

async function storedLog(key: string): Promise<string | null> {
  const object = await env.LOGS.get(key);
  return object ? hex(await object.arrayBuffer()) : null;
}

/** Gates a fork pull request run of t's repo on t's agent, as the webhook does, and returns its id: trigger and run id alike. */
async function gateForkRun(t: Tenant): Promise<string> {
  const trigger = {
    installationId: t.installationId,
    repoId: t.repoId,
    repo: t.fullName,
    sha: t.headSha,
    ref: "refs/heads/feature",
    event: "pull_request",
    pr: { number: t.prNumber, headRef: "feature", headRepoFullName: `fork${t.installationId}/api`, fork: true, authorLogin: "mallory" },
    baseSha: "0".repeat(40),
    authorLogin: "mallory",
    commitTitle: "Fork change",
    defaultBranch: "main",
    target: "checks",
    // AgentDO storage outlives each test, so every gate is a new attempt instead of a duplicate of an earlier test's.
    attempt: ++gates,
    reason: "fork_gated",
  } satisfies HubTrigger & { attempt: number; reason: "fork_gated" };
  const res = await env.AGENT_DO.get(env.AGENT_DO.idFromName(t.agentId)).fetch("https://do/gate", {
    method: "POST",
    headers: { "x-hookci-agent-id": t.agentId },
    body: JSON.stringify(trigger),
  });
  expect(res.status).toBe(202);
  const { trigger_id } = await res.json<{ trigger_id: string }>();
  // The gate posts the run to t's channel from the AgentDO's waitUntil. The fake
  // Slack refuses the post, so its claim on slack_messages is released once done.
  await vi.waitFor(async () => {
    expect(slack.calls.map((c) => c.url)).toContain("https://slack.com/api/chat.postMessage");
    expect(await env.DB.prepare("SELECT run_id FROM slack_messages WHERE run_id = ?1").bind(trigger_id).all()).toMatchObject({ results: [] });
  });
  return trigger_id;
}

/** The triggers t's AgentDO holds and the frames it queued for t's agent. */
function agentDoState(t: Tenant): Promise<{ triggers: unknown[]; outbox: unknown[] }> {
  return runInDurableObject(env.AGENT_DO.get(env.AGENT_DO.idFromName(t.agentId)), (dob) => ({
    triggers: dob.sql.exec("SELECT * FROM triggers ORDER BY created_at, trigger_id").toArray(),
    outbox: dob.sql.exec("SELECT frame FROM outbox ORDER BY seq").toArray(),
  }));
}

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function slackPost(path: string, body: string): Promise<Response> {
  const ts = String(Math.floor(testClock.now() / 1000));
  const signature = `v0=${hex(await hmacSha256(env.SLACK_SIGNING_SECRET, `v0:${ts}:${body}`))}`;
  return call(
    new Request(`https://hub.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": signature },
      body,
    }),
  );
}

/** The bodies Slack received at response URLs under prefix since the call at index from. */
function replies(prefix: string, from: number): unknown[] {
  return slack.calls.slice(from).flatMap((c) => (new URL(c.url).pathname.startsWith(prefix) ? [c.body] : []));
}

/** Runs `/hookci text` as tenant t's linked user and returns the reply posted to its response_url. */
async function slashCommand(t: Tenant, text: string): Promise<unknown> {
  const from = slack.calls.length;
  const res = await slackPost(
    "/slack/commands",
    new URLSearchParams({
      team_id: t.teamId,
      user_id: t.slackUserId,
      channel_id: t.channelId,
      command: "/hookci",
      text,
      response_url: `https://hooks.slack.com/commands/${t.teamId}/1/cmd`,
      trigger_id: "1.2.trig",
    }).toString(),
  );
  expect(res.status).toBe(200);
  const posted = replies("/commands/", from);
  expect(posted.length).toBe(1);
  return posted[0];
}

/** Presses a button as tenant t's linked user and returns the reply posted to its response_url. */
async function click(t: Tenant, actionId: string, value: string): Promise<unknown> {
  const from = slack.calls.length;
  const payload = {
    type: "block_actions",
    team: { id: t.teamId },
    user: { id: t.slackUserId, team_id: t.teamId },
    trigger_id: "1.2.trig",
    response_url: `https://hooks.slack.com/actions/${t.teamId}/1/act`,
    channel: { id: t.channelId },
    message: { ts: "1700000000.000100" },
    actions: [{ action_id: actionId, value, type: "button" }],
  };
  const res = await slackPost("/slack/interactive", new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
  expect(res.status).toBe(200);
  const posted = replies("/actions/", from);
  expect(posted.length).toBe(1);
  return posted[0];
}

describe("tenant isolation", () => {
  it("refuses A's agent uploading a log for B's run", async () => {
    const before = await storedLog(b.logKey);
    expect(before).not.toBeNull();

    const text = "forged by A\n";
    const res = await call(
      new Request(`https://hub.test/v1/logs/${b.runId}/${b.job}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${a.credential}`,
          "content-encoding": "gzip",
          "x-hookci-log-bytes": String(text.length),
          "x-hookci-log-truncated": "0",
        },
        body: await gzip(text),
      }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(await storedLog(b.logKey)).toBe(before);
    expect(denials()).toEqual([
      expect.objectContaining({ installation_id: a.installationId, agent_id: a.agentId, run_id: b.runId, job: b.job, reason: "run_not_owned" }),
    ]);
  });

  it("refuses A's agent socket frames that name B's trigger or run", async () => {
    const sock = await connect({ agentId: a.agentId, credential: a.credential, stub: env.AGENT_DO.get(env.AGENT_DO.idFromName(a.agentId)) });
    expect(await sock.hello()).toMatchObject({ type: "welcome" });
    // A real trigger B's agent is waiting on, so A's frames name one that exists, only not in A's DO.
    const triggerId = await gateForkRun(b);
    const before = await tenantRows(env, b.installationId);
    const agentB = await agentDoState(b);
    const ghFrom = gh.calls.length;

    expect(await sock.request({ type: "accepted", trigger_id: triggerId, run_id: b.runId })).toEqual([]);
    expect(await sock.request({ type: "rejected", trigger_id: triggerId, reason: "no_config" })).toEqual([]);
    expect(await sock.request({ type: "job_planned", run_id: b.runId, jobs: [{ name: "evil", needs: [] }] })).toEqual([]);
    expect(await sock.request({ type: "event", agent_seq: 1, run_id: b.runId, state: "success", duration_ms: 5 })).toEqual([]);
    expect(await sock.request({ type: "event", agent_seq: 2, run_id: b.runId, job: b.job, state: "success", duration_ms: 5 })).toEqual([]);
    expect(
      await sock.request({
        type: "annotations",
        agent_seq: 3,
        run_id: b.runId,
        job: b.job,
        items: [{ path: "src/a.ts", line: 1, level: "failure", message: "forged" }],
      }),
    ).toEqual([]);
    expect(await sock.request({ type: "token_request", run_id: b.runId, purpose: "fetch" })).toEqual([
      { v: 1, type: "error", seq: expect.any(Number), code: "auth_failed", run_id: b.runId, message: S.runNotBound },
    ]);
    sock.ws.close();

    expect(await tenantRows(env, b.installationId)).toEqual(before);
    expect(await agentDoState(b)).toEqual(agentB);
    expect(gh.calls.slice(ghFrom).filter((c) => c.url.includes("/access_tokens"))).toEqual([]);
    const who = { installation_id: a.installationId, agent_id: a.agentId };
    expect(denials()).toEqual([
      expect.objectContaining({ ...who, trigger_id: triggerId, reason: "unknown_trigger" }),
      expect.objectContaining({ ...who, trigger_id: triggerId, reason: "unknown_trigger" }),
      expect.objectContaining({ ...who, run_id: b.runId, reason: "unknown_run" }),
      expect.objectContaining({ ...who, run_id: b.runId, reason: "unknown_run" }),
      expect.objectContaining({ ...who, run_id: b.runId, reason: "unknown_run" }),
      expect.objectContaining({ ...who, run_id: b.runId, reason: "unknown_run" }),
      expect.objectContaining({ ...who, run_id: b.runId, reason: "run_not_bound" }),
    ]);
  });

  it("answers repo not found to A's slash commands naming B's repo", async () => {
    const before = await tenantRows(env, b.installationId);
    const commands = [
      `status ${b.fullName}`,
      `retry ${b.fullName}`,
      `bind ${b.fullName} ${b.agentId}`,
      `watch ${b.fullName}`,
      `unwatch ${b.fullName}`,
    ];

    for (const text of commands) {
      expect(await slashCommand(a, text)).toMatchObject({ text: S.slack.repoNotFound });
    }

    expect(await tenantRows(env, b.installationId)).toEqual(before);
    expect(denials()).toEqual(commands.map(() => expect.objectContaining({ team_id: a.teamId, repo: b.fullName, reason: "repo_not_found" })));
  });

  it("refuses A's buttons aimed at B's run, approval and agent", async () => {
    // A fork run of B's that is gated on a commit GitHub still reports as the head, so B's own approval would release it.
    const gated = await gateForkRun(b);
    gh.respond("GET", "/repos/:owner/:repo/pulls/:number", () =>
      Response.json({
        number: b.prNumber,
        state: "open",
        draft: false,
        title: "Fork change",
        user: { id: 9, login: "mallory" },
        head: { sha: b.headSha, ref: "feature", repo: { id: 9, full_name: `fork${b.installationId}/api`, fork: true } },
        base: { sha: "0".repeat(40), ref: "main", repo: { id: b.repoId, full_name: b.fullName } },
      } satisfies PullRequest),
    );
    const before = await tenantRows(env, b.installationId);
    const agentB = await agentDoState(b);

    const view = await click(a, "hookci_view_logs", `${b.runId}:${b.job}`);
    expect(view).toMatchObject({ text: S.slack.viewLogsNoAccess });
    expect(JSON.stringify(view)).not.toContain("/logs/");
    expect(await click(a, "fork:approve", `${gated}:${b.headSha}`)).toMatchObject({ text: S.forks.notGated });
    expect(await click(a, `home:revoke_agent:${b.agentId}`, String(b.installationId))).toMatchObject({ text: S.slack.forbidden });
    expect(await click(a, `home:revoke_agent:${b.agentId}`, String(a.installationId))).toMatchObject({ text: S.slack.forbidden });

    // B's fork run is still gated, its agent was sent no trigger and no approval was recorded or spent.
    expect(await tenantRows(env, b.installationId)).toEqual(before);
    expect(await agentDoState(b)).toEqual(agentB);
    expect(gh.calls.filter((c) => c.url.includes("/pulls/"))).toEqual([]);
    const user = { team_id: a.teamId, slack_user_id: a.slackUserId };
    expect(denials()).toEqual([
      expect.objectContaining({ ...user, run_id: b.runId, reason: "run_not_linked" }),
      expect.objectContaining({ ...user, run_id: gated, reason: "run_not_linked" }),
      expect.objectContaining({ team_id: a.teamId, github_login: a.githubLogin, installation_id: b.installationId, reason: "installation_not_linked" }),
      expect.objectContaining({ team_id: a.teamId, installation_id: a.installationId, agent_id: b.agentId, reason: "agent_not_found" }),
    ]);

    // The same button pressed in B's workspace releases the run to B's agent.
    expect(await click(b, "fork:approve", `${gated}:${b.headSha}`)).toMatchObject({ text: S.forks.approved });
    expect((await agentDoState(b)).outbox.length).toBe(agentB.outbox.length + 1);
  });

  it("serves B's log only to a URL signed by the hub for B's run", async () => {
    const now = new Date(testClock.now());
    const own = await call(new Request(await signLogUrl(env, { installationId: b.installationId, runId: b.runId, job: b.job }, now)));
    expect(own.status).toBe(200);
    expect(await own.text()).toContain("secret log");

    // A hub-signed link for installation A that names B's run, and A's real link retargeted at B's run.
    const crossed = await signLogUrl(env, { installationId: a.installationId, runId: b.runId, job: b.job }, now);
    const retargeted = new URL(await signLogUrl(env, { installationId: a.installationId, runId: a.runId, job: a.job }, now));
    retargeted.searchParams.set("r", b.runId);
    retargeted.searchParams.set("j", b.job);
    const forged = [crossed, retargeted.toString()];
    const exp = retargeted.searchParams.get("exp") ?? "";
    for (const key of [a.credential, a.pairToken, `xoxb-${a.teamId}`, env.SLACK_SIGNING_SECRET]) {
      const params = { i: String(b.installationId), r: b.runId, j: b.job, exp, kid: "c" };
      const sig = base64url(await hmacSha256(key, `v1\n${params.i}\n${params.r}\n${params.j}\n${exp}`));
      forged.push(`https://hub.test/logs/view?${new URLSearchParams({ ...params, sig })}`);
    }

    for (const url of forged) {
      const res = await call(new Request(url));
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(escapeHtml(S.logViewer.linkExpired));
    }
    expect(denials()).toEqual([expect.objectContaining({ installation_id: a.installationId, run_id: b.runId, reason: "run_not_owned" })]);
  });

  it("purging A leaves every B row and log in place", async () => {
    const before = await tenantRowCounts(env, b.installationId);
    for (const table of TENANT_TABLES) expect(before[table], table).toBeGreaterThan(0);
    for (const table of TENANT_TABLES) expect((await tenantRowCounts(env, a.installationId))[table], table).toBeGreaterThan(0);
    const rows = await tenantRows(env, b.installationId);
    const logBytes = await storedLog(b.logKey);

    await purgeInstallation(env.DB, a.installationId);

    expect(await tenantRows(env, b.installationId)).toEqual(rows);
    expect(Object.values(await tenantRowCounts(env, a.installationId))).toEqual(TENANT_TABLES.map(() => 0));
    // A's runs are gone, so its run-scoped rows are looked up by run id rather than through runs.
    for (const table of ["jobs", "slack_messages", "slack_job_replies"]) {
      const left = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE run_id = ?1`).bind(a.runId).first<{ n: number }>();
      expect(left?.n, table).toBe(0);
    }
    expect(await storedLog(b.logKey)).toBe(logBytes);
  });
});
