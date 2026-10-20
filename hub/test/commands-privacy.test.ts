import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRun } from "../src/db/runs";
import { tenantDb } from "../src/db/tenant";
import { getUserLink, upsertUserLink } from "../src/db/workspaces";
import { EXPORT_TTL_MS } from "../src/identity/export";
import { S } from "../src/strings";
import { ulid } from "../src/ulid";
import { testClock } from "./clock";
import {
  type CommandWorld,
  expectNoHistoryReads,
  INSTALLATION,
  LOGIN,
  REPO,
  setUpCommandWorld,
  TEAM,
  USER,
  hookci,
} from "./commands-helpers";

const OTHER_USER = "U0OTHER";
const OTHER_TEAM = "T0OTHER";

let world: CommandWorld;

beforeEach(async () => {
  world = await setUpCommandWorld();
});

afterEach(() => {
  expectNoHistoryReads(world);
  world.restore();
});

/** Author mappings and cached lookups for slackUserId in teamId. */
async function seedAuthorRows(teamId: string, slackUserId: string, login: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO author_map (installation_id, team_id, github_login, slack_user_id) VALUES (?1, ?2, ?3, ?4)").bind(
      INSTALLATION,
      teamId,
      login,
      slackUserId,
    ),
    env.DB.prepare("INSERT INTO author_cache (installation_id, team_id, key, slack_user_id, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(
      INSTALLATION,
      teamId,
      `email:${login}@example.com`,
      slackUserId,
      testClock.now() + 86_400_000,
    ),
  ]);
}

async function rowsOf(table: "author_map" | "author_cache" | "user_links"): Promise<{ team_id: string; slack_user_id: string }[]> {
  const { results } = await env.DB.prepare(`SELECT team_id, slack_user_id FROM ${table} ORDER BY team_id, slack_user_id`).all<{
    team_id: string;
    slack_user_id: string;
  }>();
  return results;
}

/** The URL of the download button in a `/hookci export` reply. */
function exportUrl(reply: { blocks?: unknown[] }): string {
  expect(reply.blocks).toEqual(
    expect.arrayContaining([{ type: "actions", elements: [expect.objectContaining({ type: "button", text: expect.objectContaining({ text: S.slack.exportButton }) })] }]),
  );
  const url = /"url":"([^"]+)"/.exec(JSON.stringify(reply.blocks))?.[1];
  expect(url).toBeDefined();
  return url ?? "";
}

describe("/hookci delete-my-data", () => {
  it("deletes only the caller's link, author mappings and cached lookups", async () => {
    await upsertUserLink(env.DB, { team_id: TEAM, slack_user_id: OTHER_USER, github_user_id: 7002, github_login: "hubot", created_at: 1 });
    await upsertUserLink(env.DB, { team_id: OTHER_TEAM, slack_user_id: USER, github_user_id: 7001, github_login: LOGIN, created_at: 1 });
    await seedAuthorRows(TEAM, USER, LOGIN);
    await seedAuthorRows(TEAM, OTHER_USER, "hubot");
    await seedAuthorRows(OTHER_TEAM, USER, LOGIN);

    const reply = await hookci(world, "delete-my-data");

    expect(reply.text).toBe(S.slack.deletedData(1, 1, 1));
    const survivors = [
      { team_id: TEAM, slack_user_id: OTHER_USER },
      { team_id: OTHER_TEAM, slack_user_id: USER },
    ];
    expect(await rowsOf("user_links")).toEqual(survivors);
    expect(await rowsOf("author_map")).toEqual(survivors);
    expect(await rowsOf("author_cache")).toEqual(survivors);
  });

  it("works for a user with no GitHub link", async () => {
    await seedAuthorRows(TEAM, OTHER_USER, "hubot");

    expect((await hookci(world, "delete-my-data", OTHER_USER)).text).toBe(S.slack.deletedData(0, 1, 1));
    expect(await rowsOf("author_map")).toEqual([]);
  });
});

describe("/hookci export", () => {
  beforeEach(async () => {
    await seedAuthorRows(TEAM, USER, LOGIN);
    const triggerId = ulid(testClock.now());
    await insertRun(tenantDb(env.DB, INSTALLATION), {
      run_id: triggerId,
      repo_id: REPO.repo_id,
      sha: "abcdef1234567890abcdef1234567890abcdef12",
      ref: "refs/heads/main",
      event: "push",
      pr_number: null,
      env: null,
      attempt: 1,
      trigger_id: triggerId,
      agent_id: null,
      state: "success",
      reason: null,
      author_login: LOGIN,
      commit_title: "Fix the build",
      started_at: 1,
      finished_at: 2,
      duration_ms: 1,
      log_key: null,
    });
  });

  it("links to a JSON copy of the caller's link, mappings and runs", async () => {
    const reply = await hookci(world, "export");
    expect(reply.text).toBe(S.slack.exportSummary(LOGIN, 1, 1, 14));

    const res = await exports.default.fetch(exportUrl(reply));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.json()).toMatchObject({
      v: 1,
      slack: { team_id: TEAM, user_id: USER },
      github_link: { github_user_id: 7001, github_login: LOGIN },
      author_mappings: [{ installation_id: INSTALLATION, github_login: LOGIN }],
      runs: [{ repo: REPO.full_name, sha: "abcdef1234567890abcdef1234567890abcdef12", target: "checks", state: "success" }],
    });
    expect(await getUserLink(env.DB, TEAM, USER)).not.toBeNull();
  });

  it("rejects the link once 15 minutes have passed", async () => {
    const url = exportUrl(await hookci(world, "export"));

    testClock.advance(EXPORT_TTL_MS + 1000);
    const res = await exports.default.fetch(url);

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "export_token_expired" });
  });

  it("rejects a link whose token was changed", async () => {
    const url = new URL(exportUrl(await hookci(world, "export")));
    const token = url.searchParams.get("token") ?? "";
    url.searchParams.set("token", token.replace(USER, OTHER_USER));

    const res = await exports.default.fetch(url.toString());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "export_token_invalid" });
  });

  it("prompts an unlinked user to run /hookci me", async () => {
    expect((await hookci(world, "export", OTHER_USER)).text).toBe(S.slack.notLinked);
  });
});
