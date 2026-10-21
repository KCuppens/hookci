import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { hex, hmacSha256 } from "../../src/crypto";
import { bind } from "../../src/db/bindings";
import { tenantDb } from "../../src/db/tenant";
import worker from "../../src/index";
import { testClock } from "../clock";
import { type CommandWorld, INSTALLATION, REPO, setUpCommandWorld, TEAM, USER } from "../commands-helpers";
import { type Agent, seedAgent } from "../do/agent-socket";
import { serveRepoFiles } from "../fakes/github";
import prFork from "../fixtures/github/pull_request.synchronize.fork.json";
import { type RecordingSink, recordSink } from "../sinks/recording";

export const PR = 9;
export const BASE_SHA = prFork.pull_request.base.sha;
export const HEAD_SHA = prFork.pull_request.head.sha;
const ACTION_URL = "https://hooks.slack.com/actions/T0ACME/1/xyz";
/** The files key of `.hookci.yml` on the fork PR's base SHA. */
export const POLICY_FILE = `${REPO.full_name}@${BASE_SHA}:.hookci.yml`;

export interface ForkWorld extends CommandWorld {
  agent: Agent;
  sink: RecordingSink;
  /** Files the contents endpoint serves, keyed as serveRepoFiles reads them; see POLICY_FILE. */
  files: Record<string, string>;
  /** Every ref the contents endpoint was asked for. */
  refs: string[];
  /** The pull request head the fake GitHub reports. */
  pull: { headSha: string };
}

/** The command world plus an agent bound to REPO's checks, served policy files and the fork PR. */
export async function setUpForkWorld(): Promise<ForkWorld> {
  const world = await setUpCommandWorld();
  world.slack.respond("POST", /^\/actions\//, () => new Response("ok"));
  const agent = await seedAgent(INSTALLATION);
  await bind(tenantDb(env.DB, INSTALLATION), REPO.repo_id, "checks", agent.agentId);
  const files: Record<string, string> = {};
  const refs = serveRepoFiles(world.gh, files);
  const pull = { headSha: HEAD_SHA };
  world.gh.respond("GET", "/repos/:owner/:repo/pulls/:n", () =>
    Response.json({ ...prFork.pull_request, head: { ...prFork.pull_request.head, sha: pull.headSha } }),
  );
  world.gh.respond("POST", "/repos/:owner/:repo/check-runs", () => Response.json({ id: 1 }, { status: 201 }));
  world.gh.respond("PATCH", "/repos/:owner/:repo/check-runs/:id", () => Response.json({ id: 1 }));
  const sink = recordSink();
  const restore = world.restore;
  return {
    ...world,
    agent,
    sink,
    files,
    refs,
    pull,
    restore() {
      sink.undo();
      restore();
    },
  };
}

/** Delivers a GitHub webhook signed with the app secret, waiting for its background work. */
export async function deliver(event: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers = new Headers({
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": crypto.randomUUID(),
    "x-hub-signature-256": `sha256=${hex(await hmacSha256(env.GITHUB_WEBHOOK_SECRET, body))}`,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://hub.test/github/webhook", { method: "POST", headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** The fork fixture moved onto INSTALLATION's REPO, at headSha. */
export function forkPush(headSha = HEAD_SHA): typeof prFork {
  return {
    ...prFork,
    installation: { ...prFork.installation, id: INSTALLATION },
    repository: { ...prFork.repository, id: REPO.repo_id, full_name: REPO.full_name },
    pull_request: { ...prFork.pull_request, head: { ...prFork.pull_request.head, sha: headSha } },
  };
}

export type Row = Record<string, unknown>;

export async function runs(): Promise<Row[]> {
  return (await env.DB.prepare("SELECT * FROM runs ORDER BY rowid").all<Row>()).results;
}

/** The frames the AgentDO queued for its agent, oldest first. */
export function outbox(agent: Agent): Promise<Row[]> {
  return runInDurableObject(agent.stub, (dob) =>
    dob.sql
      .exec<{ frame: string }>("SELECT frame FROM outbox ORDER BY seq")
      .toArray()
      .map((row): Row => JSON.parse(row.frame)),
  );
}

/** Clicks a block_actions button as userId and returns the reply posted to response_url. */
export async function click(world: CommandWorld, actionId: string, value: string, userId = USER): Promise<{ text: string }> {
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      team: { id: TEAM },
      user: { id: userId, team_id: TEAM },
      trigger_id: "1.2.trig",
      response_url: ACTION_URL,
      channel: { id: "C0CHAN" },
      message: { ts: "1700000000.000100" },
      actions: [{ action_id: actionId, value, type: "button" }],
    }),
  }).toString();
  const ts = Math.floor(testClock.now() / 1000);
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${hex(await hmacSha256(env.SLACK_SIGNING_SECRET, `v0:${ts}:${body}`))}`,
  });
  const before = world.slack.calls.filter((c) => c.url === ACTION_URL).length;
  const ctx = createExecutionContext();
  await worker.fetch(new Request("https://hub.test/slack/interactive", { method: "POST", headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  const posts = world.slack.calls.filter((c) => c.url === ACTION_URL);
  if (posts.length !== before + 1) throw new Error(`expected one response_url post, got ${posts.length - before}`);
  return posts.at(-1)!.body as { text: string };
}
