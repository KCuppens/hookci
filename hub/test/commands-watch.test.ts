import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWatchesForRepo } from "../src/db/watches";
import { tenantDb } from "../src/db/tenant";
import { insertRun } from "../src/db/runs";
import { S } from "../src/strings";
import { testClock } from "./clock";
import {
  type CommandWorld,
  CHANNEL,
  expectNoHistoryReads,
  INSTALLATION,
  LOGIN,
  permissionCalls,
  REPO,
  setUpCommandWorld,
  slackCalls,
  TEAM,
  USER,
  hookci,
} from "./commands-helpers";
import { seedAgent } from "./do/agent-socket";

let world: CommandWorld;

beforeEach(async () => {
  world = await setUpCommandWorld();
  world.slack.respond("POST", "/api/conversations.info", () => Response.json({ ok: true, channel: { id: CHANNEL, is_member: true } }));
  world.slack.respond("POST", "/api/chat.postMessage", () => Response.json({ ok: true, ts: "1700000000.000100" }));
});

afterEach(() => {
  expectNoHistoryReads(world);
  world.restore();
});

function watches() {
  return listWatchesForRepo(tenantDb(env.DB, INSTALLATION), REPO.repo_id);
}

describe("/hookci watch", () => {
  it("asks for an invite and creates no watch when the bot is not in the channel", async () => {
    world.roles[LOGIN] = "write";
    world.slack.respond("POST", "/api/conversations.info", () => Response.json({ ok: true, channel: { id: CHANNEL, is_member: false } }));

    const reply = await hookci(world, "watch acme/api");

    expect(reply.text).toContain("/invite @hookci");
    expect(await watches()).toEqual([]);
    expect(slackCalls(world, "chat.postMessage")).toEqual([]);
  });

  it("asks for an invite when Slack does not show the channel to the bot", async () => {
    world.roles[LOGIN] = "write";
    world.slack.respond("POST", "/api/conversations.info", () => Response.json({ ok: false, error: "channel_not_found" }));

    expect((await hookci(world, "watch acme/api")).text).toBe(S.slack.inviteFirst);
    expect(await watches()).toEqual([]);
  });

  it("watches quietly for a write user and posts one test badge as the bot", async () => {
    world.roles[LOGIN] = "write";

    const reply = await hookci(world, "watch acme/api quiet");

    expect(reply.text).toBe(S.slack.watching("acme/api"));
    expect(await watches()).toEqual([
      expect.objectContaining({ team_id: TEAM, channel_id: CHANNEL, notify: "quiet", alert: "channel", status: "active", created_by: USER }),
    ]);
    const posts = slackCalls(world, "chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ channel: CHANNEL, text: expect.stringContaining("(test)"), blocks: expect.stringContaining('"type":"section"') });
    expect(world.slack.calls.find((c) => c.url.startsWith("https://slack.com/"))?.body).toEqual({ channel: CHANNEL });
  });

  it("takes dm as alert mode and a maintainer counts as write", async () => {
    world.roles[LOGIN] = "maintain";

    await hookci(world, "watch ACME/API dm");

    expect(await watches()).toEqual([expect.objectContaining({ notify: "normal", alert: "dm" })]);
  });

  it("refuses a user who can only read the repo", async () => {
    world.roles[LOGIN] = "read";

    expect((await hookci(world, "watch acme/api")).text).toBe(S.slack.forbidden);
    expect(await watches()).toEqual([]);
    expect(slackCalls(world, "conversations.info")).toEqual([]);
  });

  it("prompts an unlinked user to run /hookci me", async () => {
    const reply = await hookci(world, "watch acme/api", "U0STRANGER");

    expect(reply.text).toBe(S.slack.notLinked);
    expect(reply.text).toContain("/hookci me");
    expect(permissionCalls(world)).toEqual([]);
  });

  it("answers a repo outside the linked installations with repo not found", async () => {
    world.roles[LOGIN] = "admin";

    expect((await hookci(world, "watch acme/elsewhere")).text).toBe(S.slack.repoNotFound);
  });

  it("answers an unknown option with usage", async () => {
    world.roles[LOGIN] = "write";

    expect((await hookci(world, "watch acme/api loud")).text).toBe(S.slack.usage("/hookci watch <owner/repo> [quiet] [dm]"));
    expect(await watches()).toEqual([]);
  });
});

describe("/hookci unwatch", () => {
  it("removes this channel's watch and says so when there is none", async () => {
    world.roles[LOGIN] = "write";
    await hookci(world, "watch acme/api");

    expect((await hookci(world, "unwatch acme/api")).text).toBe(S.slack.unwatched("acme/api"));
    expect(await watches()).toEqual([]);
    expect((await hookci(world, "unwatch acme/api")).text).toBe(S.slack.notWatching("acme/api"));
  });
});

describe("GitHub permission cache", () => {
  it("asks GitHub once per user and repo within 5 minutes and again after", async () => {
    world.roles[LOGIN] = "write";

    await hookci(world, "watch acme/api");
    await hookci(world, "unwatch acme/api");
    expect(permissionCalls(world)).toHaveLength(1);

    testClock.advance(301_000);
    await hookci(world, "watch acme/api");
    expect(permissionCalls(world)).toHaveLength(2);
  });

  it("drops a revoked role after the 5 minutes", async () => {
    world.roles[LOGIN] = "write";
    await hookci(world, "watch acme/api");

    world.roles[LOGIN] = "read";
    testClock.advance(301_000);
    expect((await hookci(world, "unwatch acme/api")).text).toBe(S.slack.forbidden);
  });
});

describe("/hookci status", () => {
  it("lists the agents with their online state and the repo's last runs", async () => {
    world.roles[LOGIN] = "read";
    const agent = await seedAgent(INSTALLATION);
    await insertRun(tenantDb(env.DB, INSTALLATION), {
      run_id: "run_1",
      repo_id: REPO.repo_id,
      sha: "abcdef1234567890abcdef1234567890abcdef12",
      ref: "refs/heads/main",
      event: "push",
      pr_number: null,
      env: null,
      attempt: 1,
      trigger_id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      agent_id: agent.agentId,
      state: "success",
      reason: null,
      author_login: LOGIN,
      commit_title: "Fix the build",
      started_at: 1,
      finished_at: 41_201,
      duration_ms: 41_200,
      log_key: null,
    });

    const reply = await hookci(world, "status acme/api");

    expect(reply.text).toContain("builder: offline, last seen never");
    expect(reply.text).toContain(S.slack.statusRuns("acme/api"));
    expect(reply.text).toContain(":large_green_circle: checks · abcdef1 · 41.2s");
  });

  it("shows agents without a repo to any linked user", async () => {
    await seedAgent(INSTALLATION);

    const reply = await hookci(world, "status");

    expect(reply.text).toContain("builder: offline");
    expect(permissionCalls(world)).toEqual([]);
  });

  it("lists every agent when one AgentDO fails, the failed one from its D1 state", async () => {
    await seedAgent(INSTALLATION);
    const broken = await seedAgent(INSTALLATION);
    await env.DB.prepare("UPDATE agents SET name = 'broken', last_seen_at = 5000 WHERE agent_id = ?1").bind(broken.agentId).run();
    const real = env.AGENT_DO;
    env.AGENT_DO = {
      idFromName: (name: string) => (name === broken.agentId ? null : real.idFromName(name)),
      get: (id: DurableObjectId | null) => ({
        fetch: (input: string, init?: RequestInit) => (id === null ? Promise.reject(new Error("AgentDO down")) : real.get(id).fetch(input, init)),
      }),
    } as unknown as typeof env.AGENT_DO;
    try {
      const reply = await hookci(world, "status");
      expect(reply.text).toContain("builder: offline, last seen never");
      expect(reply.text).toContain("broken: offline, last seen <!date^5^");
    } finally {
      env.AGENT_DO = real;
    }
  });
});

describe("/hookci help", () => {
  it("lists every command on its own line", async () => {
    const reply = await hookci(world, "help");

    expect(reply.text).toBe(S.slack.help);
    for (const cmd of ["watch", "unwatch", "status", "retry", "bind", "me", "export", "delete-my-data", "help"]) {
      expect(reply.text.split("\n").some((line) => line.startsWith(`\`/hookci ${cmd}`))).toBe(true);
    }
  });
});
