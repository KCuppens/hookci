import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hex, hmacSha256 } from "../../src/crypto";
import { upsertRepos } from "../../src/db/repos";
import { tenantDb } from "../../src/db/tenant";
import worker from "../../src/index";
import { LOG_URL_TTL_SEC, verifyLogUrl } from "../../src/logs/signing";
import { S } from "../../src/strings";
import { testClock } from "../clock";
import { type CommandWorld, INSTALLATION, LOGIN, OTHER_INSTALLATION, REPO, setUpCommandWorld, TEAM, USER } from "../commands-helpers";
import { seedRun } from "./helpers";

const RESPONSE_URL = "https://hooks.slack.com/actions/T0ACME/1/xyz";
const RUN = "run_view_1";
const FOREIGN_RUN = "run_view_2";

let world: CommandWorld;

beforeEach(async () => {
  world = await setUpCommandWorld();
  world.slack.respond("POST", /^\/actions\//, () => new Response("ok"));
  await seedRun(INSTALLATION, REPO.repo_id, RUN, null);
  await upsertRepos(tenantDb(env.DB, OTHER_INSTALLATION), [{ repo_id: 901, full_name: "other/api", default_branch: "main" }]);
  await seedRun(OTHER_INSTALLATION, 901, FOREIGN_RUN, null);
});

afterEach(() => world.restore());

/** Clicks View log as userId through the signed /slack/interactive endpoint and returns the reply posted to response_url. */
async function clickViewLog(value: string, userId = USER): Promise<{ response_type?: string; text?: string }> {
  const payload = {
    type: "block_actions",
    team: { id: TEAM },
    user: { id: userId, team_id: TEAM },
    trigger_id: "1.2.trig",
    response_url: RESPONSE_URL,
    channel: { id: "C0CHAN" },
    message: { ts: "1700000000.000100" },
    actions: [{ action_id: "log:view", value, type: "button" }],
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
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  const posts = world.slack.calls.filter((c) => c.url === RESPONSE_URL);
  expect(posts).toHaveLength(1);
  const reply = posts[0]?.body;
  if (typeof reply !== "object" || reply === null) throw new Error("response_url got no JSON reply");
  return reply;
}

describe("log:view action", () => {
  it("answers a linked reader alone with a fresh signed link to the job's log", async () => {
    world.roles[LOGIN] = "read";
    const reply = await clickViewLog(`${RUN}:test`);
    expect(reply.response_type).toBe("ephemeral");
    const url = reply.text?.match(/<([^|>]+)\|/)?.[1] ?? "";
    expect(reply.text).toBe(S.slack.logLink(url));
    const link = new URL(url);
    expect(`${link.origin}${link.pathname}`).toBe(`${env.HUB_ORIGIN}/logs/view`);
    expect(Number(link.searchParams.get("exp"))).toBe(Math.floor(testClock.now() / 1000) + LOG_URL_TTL_SEC);
    expect(await verifyLogUrl(env, link.searchParams, new Date(testClock.now()))).toEqual({
      ok: true,
      ref: { installationId: INSTALLATION, runId: RUN, job: "test" },
    });
  });

  it("answers an unlinked Slack user with the /zeroci me prompt", async () => {
    world.roles[LOGIN] = "read";
    expect(await clickViewLog(`${RUN}:test`, "U0STRANGER")).toEqual({ response_type: "ephemeral", text: S.slack.notLinked });
  });

  it("refuses a linked user without read access to the repo", async () => {
    expect(await clickViewLog(`${RUN}:test`)).toEqual({ response_type: "ephemeral", text: S.slack.forbidden });
  });

  it("refuses a run of an installation the workspace is not linked to", async () => {
    world.roles[LOGIN] = "admin";
    expect(await clickViewLog(`${FOREIGN_RUN}:test`)).toEqual({ response_type: "ephemeral", text: S.slack.forbidden });
  });

  it("refuses a value that names no run", async () => {
    world.roles[LOGIN] = "read";
    expect(await clickViewLog("test")).toEqual({ response_type: "ephemeral", text: S.slack.forbidden });
  });
});
