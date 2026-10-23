import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hex, hmacSha256 } from "../../src/crypto";
import { upsertRepos } from "../../src/db/repos";
import { tenantDb } from "../../src/db/tenant";
import worker from "../../src/index";
import { LOG_URL_TTL_SEC, verifyLogUrl } from "../../src/logs/signing";
import { VIEW_LOGS_ACTION } from "../../src/slack/view-logs";
import { S } from "../../src/strings";
import { testClock } from "../clock";
import { type CommandWorld, INSTALLATION, LOGIN, OTHER_INSTALLATION, permissionCalls, REPO, setUpCommandWorld, TEAM, USER } from "../commands-helpers";
import { seedRun } from "../logs/helpers";

const RESPONSE_URL = "https://hooks.slack.com/actions/T0ACME/1/xyz";
const RUN = "run_view_1";
const FOREIGN_RUN = "run_view_2";

let world: CommandWorld;
/** Visibility the fake GitHub reports per repository id; absent ids get 404. */
let visibility: Record<number, "public" | "private">;

beforeEach(async () => {
  world = await setUpCommandWorld();
  world.slack.respond("POST", /^\/actions\//, () => new Response("ok"));
  visibility = { [REPO.repo_id]: "private" };
  world.gh.respond("GET", "/repositories/:id", ({ params }) => {
    const id = Number(params.id);
    const seen = visibility[id];
    if (!seen) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ id, name: "api", full_name: REPO.full_name, private: seen === "private", owner: { login: "acme" } });
  });
  await seedRun(INSTALLATION, REPO.repo_id, RUN, null);
  await upsertRepos(tenantDb(env.DB, OTHER_INSTALLATION), [{ repo_id: 901, full_name: "other/api", default_branch: "main" }]);
  await seedRun(OTHER_INSTALLATION, 901, FOREIGN_RUN, null);
});

afterEach(() => world.restore());

/** Clicks View logs as userId through the signed /slack/interactive endpoint and returns the reply posted to response_url. */
async function clickViewLogs(value: string, userId = USER): Promise<{ response_type?: string; text?: string }> {
  const payload = {
    type: "block_actions",
    team: { id: TEAM },
    user: { id: userId, team_id: TEAM },
    trigger_id: "1.2.trig",
    response_url: RESPONSE_URL,
    channel: { id: "C0CHAN" },
    message: { ts: "1700000000.000100" },
    actions: [{ action_id: VIEW_LOGS_ACTION, value, type: "button" }],
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

/** The signed viewer URL in a logLink reply, checked to verify for RUN's test job. */
async function signedLinkIn(reply: { text?: string }): Promise<URL> {
  const url = reply.text?.match(/<([^|>]+)\|/)?.[1] ?? "";
  expect(reply.text).toBe(S.slack.logLink(url));
  const link = new URL(url);
  expect(`${link.origin}${link.pathname}`).toBe(`${env.HUB_ORIGIN}/logs/view`);
  expect(await verifyLogUrl(env, link.searchParams, new Date(testClock.now()))).toEqual({
    ok: true,
    ref: { installationId: INSTALLATION, runId: RUN, job: "test" },
  });
  return link;
}

describe("View logs button", () => {
  it("answers a linked user with a role on the private repo alone with a 15-minute signed link", async () => {
    world.roles[LOGIN] = "read";
    const reply = await clickViewLogs(`${RUN}:test`);
    expect(reply.response_type).toBe("ephemeral");
    const link = await signedLinkIn(reply);
    expect(Number(link.searchParams.get("exp"))).toBe(Math.floor(testClock.now() / 1000) + LOG_URL_TTL_SEC);
    expect(permissionCalls(world)).toHaveLength(1);
  });

  it("answers any linked user of a public repo without asking for their role", async () => {
    visibility[REPO.repo_id] = "public";
    await signedLinkIn(await clickViewLogs(`${RUN}:test`));
    expect(permissionCalls(world)).toEqual([]);
  });

  it("asks GitHub on every click, so a removed collaborator loses access at once", async () => {
    world.roles[LOGIN] = "read";
    await signedLinkIn(await clickViewLogs(`${RUN}:test`));
    delete world.roles[LOGIN];
    world.slack.calls.length = 0;
    expect(await clickViewLogs(`${RUN}:test`)).toEqual({ response_type: "ephemeral", text: S.slack.viewLogsNoAccess });
    expect(permissionCalls(world)).toHaveLength(2);
  });

  it("tells an unlinked Slack user to link with /hookci me", async () => {
    world.roles[LOGIN] = "read";
    expect(await clickViewLogs(`${RUN}:test`, "U0STRANGER")).toEqual({ response_type: "ephemeral", text: S.slack.viewLogsNotLinked });
  });

  it("refuses a linked user without a role on the private repo", async () => {
    expect(await clickViewLogs(`${RUN}:test`)).toEqual({ response_type: "ephemeral", text: S.slack.viewLogsNoAccess });
  });

  it("refuses a repository the installation no longer sees", async () => {
    world.roles[LOGIN] = "admin";
    delete visibility[REPO.repo_id];
    expect(await clickViewLogs(`${RUN}:test`)).toEqual({ response_type: "ephemeral", text: S.slack.viewLogsNoAccess });
  });

  it("refuses a run of an installation the workspace is not linked to, an unknown job and a value naming no run", async () => {
    world.roles[LOGIN] = "admin";
    visibility[901] = "public";
    for (const value of [`${FOREIGN_RUN}:test`, `${RUN}:lint`, "test"]) {
      world.slack.calls.length = 0;
      expect(await clickViewLogs(value)).toEqual({ response_type: "ephemeral", text: S.slack.viewLogsNoAccess });
    }
  });
});
