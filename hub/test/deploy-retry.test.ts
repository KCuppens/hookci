import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hex, hmacSha256 } from "../src/crypto";
import { bind } from "../src/db/bindings";
import { tenantDb } from "../src/db/tenant";
import { RETRY_ACTION, upsertDeployRender } from "../src/deploy/render";
import { handleDeployRetry } from "../src/deploy/retry";
import worker from "../src/index";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { type CommandWorld, INSTALLATION, LOGIN, permissionCalls, REPO, setUpCommandWorld, TEAM, USER } from "./commands-helpers";
import { seedAgent } from "./do/agent-socket";

const SHA = "c".repeat(40);
const AGENT = "agt_deployer";
const RUN = "run_deploy_1";
const RESPONSE_URL = "https://hooks.slack.com/actions/T0ACME/1/retry";

type Row = Record<string, unknown>;

let world: CommandWorld;
let triggers: { agentId: string; body: Row }[];
let savedAgentDo: typeof env.AGENT_DO;

/** Swaps env.AGENT_DO for a stub that records each `/trigger` post. */
function fakeAgentDo(): void {
  savedAgentDo = env.AGENT_DO;
  const stub = (agentId: string) => ({
    async fetch(input: string, init?: RequestInit): Promise<Response> {
      if (new URL(input).pathname !== "/trigger") return new Response("not found", { status: 404 });
      triggers.push({ agentId, body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    },
  });
  env.AGENT_DO = { idFromName: (name: string) => name, get: (id: string) => stub(id) } as unknown as typeof env.AGENT_DO;
}

async function seedTrigger(attempt: number, runId: string, event: "push" | "retry"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO deploy_triggers (installation_id, repo, sha, env, attempt, event, ref, trigger_id, agent_id, run_id, status, created_at, updated_at)
    VALUES (?1, ?2, ?3, 'staging', ?4, ?5, 'refs/heads/main', ?6, ?7, ?8, 'accepted', 1, 1)`,
  )
    .bind(INSTALLATION, REPO.full_name, SHA, attempt, event, `trg_${runId}`, AGENT, runId)
    .run();
  await upsertDeployRender(tenantDb(env.DB, INSTALLATION), {
    run_id: runId,
    repo: REPO.full_name,
    env: "staging",
    sha: SHA,
    slack_channel: "C0CHAN",
    slack_ts: "1700000000.000100",
    check_run_id: null,
    state: "failed",
    step: "migrate",
    step_index: 2,
    steps_total: 8,
    started_at: 1,
    updated_at: 1,
  });
}

async function triggerRows(): Promise<Row[]> {
  return (await env.DB.prepare("SELECT * FROM deploy_triggers ORDER BY attempt").all<Row>()).results;
}

function click(value: string, userId = USER) {
  return handleDeployRetry(env, { teamId: TEAM, userId, value });
}

beforeEach(async () => {
  world = await setUpCommandWorld();
  triggers = [];
  fakeAgentDo();
  await bind(tenantDb(env.DB, INSTALLATION), REPO.repo_id, "deploy:staging", AGENT);
  await seedTrigger(1, RUN, "push");
});

afterEach(() => {
  env.AGENT_DO = savedAgentDo;
  world.restore();
});

describe("deploy Retry button", () => {
  it("retry unlinked user", async () => {
    expect(await click(`${RUN}:1`, "U0STRANGER")).toEqual({ response_type: "ephemeral", text: S.slack.notLinked });
    expect(triggers).toEqual([]);
    expect(await triggerRows()).toHaveLength(1);
    expect(permissionCalls(world)).toEqual([]);
  });

  it("retry read-only user", async () => {
    world.roles[LOGIN] = "read";
    expect(await click(`${RUN}:1`)).toEqual({ response_type: "ephemeral", text: S.deploy.retryForbidden(REPO.full_name) });
    expect(S.deploy.retryForbidden(REPO.full_name)).toBe("You need write access to acme/api to retry deploys");
    expect(triggers).toEqual([]);
    expect(await triggerRows()).toHaveLength(1);
  });

  it("retry write user", async () => {
    world.roles[LOGIN] = "write";
    expect(await click(`${RUN}:1`)).toBeNull();

    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      agentId: AGENT,
      body: { repo: REPO.full_name, sha: SHA, ref: "refs/heads/main", target: "deploy:staging", attempt: 2, retry: true, trust: "trusted" },
    });
    expect((await triggerRows())[1]).toMatchObject({ attempt: 2, event: "retry", agent_id: AGENT, status: "sent", trigger_id: triggers[0]?.body.triggerId });
  });

  it("retry write user reaches the bound agent as an event retry trigger frame", async () => {
    env.AGENT_DO = savedAgentDo;
    world.roles[LOGIN] = "write";
    const agent = await seedAgent(INSTALLATION);
    await bind(tenantDb(env.DB, INSTALLATION), REPO.repo_id, "deploy:staging", agent.agentId);

    expect(await click(`${RUN}:1`)).toBeNull();

    const frames = await runInDurableObject(agent.stub, (dob) =>
      dob.sql
        .exec<{ frame: string }>("SELECT frame FROM outbox ORDER BY seq")
        .toArray()
        .map((row): Row => JSON.parse(row.frame)),
    );
    expect(frames).toEqual([expect.objectContaining({ type: "trigger", repo: REPO.full_name, sha: SHA, env: "staging", event: "retry", attempt: 2 })]);
  });

  it.each(["maintain", "admin"])("retry %s user dispatches like write", async (role) => {
    world.roles[LOGIN] = role;
    expect(await click(`${RUN}:1`)).toBeNull();
    expect(triggers.map((t) => t.body.attempt)).toEqual([2]);
  });

  it("retry double click", async () => {
    world.roles[LOGIN] = "write";
    const replies = await Promise.all([click(`${RUN}:1`), click(`${RUN}:1`)]);
    const already = { response_type: "ephemeral", text: S.deploy.retryAlreadyRequested };
    expect(replies.filter((r) => r === null)).toHaveLength(1);
    expect(replies.filter((r) => r !== null)).toEqual([already]);
    expect(await click(`${RUN}:1`)).toEqual(already);

    expect(triggers).toHaveLength(1);
    expect((await triggerRows()).map((r) => r.attempt)).toEqual([1, 2]);
    expect(S.deploy.retryAlreadyRequested).toBe("Retry already requested");
  });

  it("retry stale button", async () => {
    world.roles[LOGIN] = "write";
    await seedTrigger(2, "run_deploy_2", "retry");

    expect(await click(`${RUN}:1`)).toEqual({ response_type: "ephemeral", text: S.deploy.retryAlreadyRequested });
    expect(triggers).toEqual([]);
    expect((await triggerRows()).map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("refuses a value that names no deploy run of this workspace", async () => {
    world.roles[LOGIN] = "write";
    for (const value of ["run_missing:1", `${RUN}:7`, RUN, ""]) {
      expect(await click(value)).toEqual({ response_type: "ephemeral", text: S.deploy.retryNoRun });
    }
    await env.DB.prepare("DELETE FROM workspace_links").run();
    expect(await click(`${RUN}:1`)).toEqual({ response_type: "ephemeral", text: S.deploy.retryNoRun });
    expect(triggers).toEqual([]);
  });

  it("acks the Slack click at once and dispatches through the interactivity route", async () => {
    world.roles[LOGIN] = "write";
    world.slack.respond("POST", /^\/actions\//, () => new Response("ok"));
    const payload = {
      type: "block_actions",
      team: { id: TEAM },
      user: { id: USER, team_id: TEAM },
      trigger_id: "1.2.trig",
      response_url: RESPONSE_URL,
      channel: { id: "C0CHAN" },
      message: { ts: "1700000000.000100" },
      actions: [{ action_id: RETRY_ACTION, value: `${RUN}:1`, type: "button" }],
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const ts = Math.floor(testClock.now() / 1000);
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": `v0=${hex(await hmacSha256(env.SLACK_SIGNING_SECRET, `v0:${ts}:${body}`))}`,
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://hub.test/slack/interactive", { method: "POST", headers, body }), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    await waitOnExecutionContext(ctx);

    expect(triggers.map((t) => t.body)).toEqual([expect.objectContaining({ retry: true, attempt: 2, target: "deploy:staging" })]);
    expect(world.slack.calls.filter((c) => c.url === RESPONSE_URL)).toEqual([]);
  });
});
