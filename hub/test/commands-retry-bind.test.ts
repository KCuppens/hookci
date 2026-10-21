import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bind, getBinding } from "../src/db/bindings";
import { insertRun, type NewRun } from "../src/db/runs";
import { tenantDb } from "../src/db/tenant";
import { S } from "../src/strings";
import {
  type CommandWorld,
  expectNoHistoryReads,
  INSTALLATION,
  LOGIN,
  OTHER_INSTALLATION,
  REPO,
  setUpCommandWorld,
  hookci,
} from "./commands-helpers";
import { seedAgent } from "./do/agent-socket";

const SHA = "abcdef1234567890abcdef1234567890abcdef12";

let world: CommandWorld;

beforeEach(async () => {
  world = await setUpCommandWorld();
});

afterEach(() => {
  expectNoHistoryReads(world);
  world.restore();
});

function seedRun(over: Partial<NewRun> = {}): Promise<void> {
  return insertRun(tenantDb(env.DB, INSTALLATION), {
    run_id: "01HAAAAAAAAAAAAAAAAAAAAAAA",
    repo_id: REPO.repo_id,
    sha: SHA,
    ref: "refs/heads/main",
    event: "push",
    pr_number: null,
    env: null,
    attempt: 1,
    trigger_id: "01HAAAAAAAAAAAAAAAAAAAAAAA",
    agent_id: null,
    state: "failed",
    reason: null,
    author_login: LOGIN,
    commit_title: "Fix the build",
    started_at: 1,
    finished_at: 2,
    duration_ms: 1,
    log_key: null,
    ...over,
  });
}

async function runsOfRepo(): Promise<{ attempt: number; sha: string; agent_id: string | null }[]> {
  const { results } = await env.DB.prepare("SELECT attempt, sha, agent_id FROM runs WHERE installation_id = ?1 AND repo_id = ?2 ORDER BY attempt")
    .bind(INSTALLATION, REPO.repo_id)
    .all<{ attempt: number; sha: string; agent_id: string | null }>();
  return results;
}

describe("/hookci retry", () => {
  it("sends the bound agent's AgentDO the latest run again as attempt + 1", async () => {
    world.roles[LOGIN] = "write";
    const agent = await seedAgent(INSTALLATION);
    await bind(tenantDb(env.DB, INSTALLATION), REPO.repo_id, "checks", agent.agentId);
    await seedRun({ agent_id: agent.agentId });

    const reply = await hookci(world, "retry acme/api");

    expect(reply.text).toBe(S.slack.retryOffline("acme/api", "abcdef1", 2));
    expect(await runsOfRepo()).toEqual([
      { attempt: 1, sha: SHA, agent_id: agent.agentId },
      { attempt: 2, sha: SHA, agent_id: agent.agentId },
    ]);
  });

  it("retries the run of the named commit", async () => {
    world.roles[LOGIN] = "admin";
    const agent = await seedAgent(INSTALLATION);
    await bind(tenantDb(env.DB, INSTALLATION), REPO.repo_id, "checks", agent.agentId);
    await seedRun({ attempt: 3 });
    await seedRun({ run_id: "01HBBBBBBBBBBBBBBBBBBBBBBB", trigger_id: "01HBBBBBBBBBBBBBBBBBBBBBBB", sha: "1".repeat(40) });

    await hookci(world, "retry acme/api abcdef1");

    expect((await runsOfRepo()).filter((run) => run.sha === SHA).map((run) => run.attempt)).toEqual([3, 4]);
  });

  it("says so when the repo has no run or no bound agent", async () => {
    world.roles[LOGIN] = "write";
    expect((await hookci(world, "retry acme/api")).text).toBe(S.slack.retryNoRun("acme/api", undefined));

    await seedRun();
    expect((await hookci(world, "retry acme/api")).text).toBe(S.slack.retryNoAgent("acme/api", "checks"));
    expect(await runsOfRepo()).toHaveLength(1);
  });

  it("refuses a user who can only read the repo", async () => {
    world.roles[LOGIN] = "read";
    await seedRun();

    expect((await hookci(world, "retry acme/api")).text).toBe(S.slack.forbidden);
    expect(await runsOfRepo()).toHaveLength(1);
  });
});

describe("/hookci bind", () => {
  it("binds an agent of the repo's installation by name for an admin", async () => {
    world.roles[LOGIN] = "admin";
    const agent = await seedAgent(INSTALLATION);

    expect((await hookci(world, "bind acme/api builder deploy:prod")).text).toBe(S.slack.bound("acme/api", "deploy:prod", "builder"));
    expect(await getBinding(tenantDb(env.DB, INSTALLATION), REPO.repo_id, "deploy:prod")).toMatchObject({ agent_id: agent.agentId });
  });

  it("refuses an agent of another installation and keeps the binding", async () => {
    world.roles[LOGIN] = "admin";
    const mine = await seedAgent(INSTALLATION);
    await bind(tenantDb(env.DB, INSTALLATION), REPO.repo_id, "checks", mine.agentId);
    const foreign = await seedAgent(OTHER_INSTALLATION);

    expect((await hookci(world, `bind acme/api ${foreign.agentId}`)).text).toBe(S.slack.agentNotFound(foreign.agentId));
    expect(await getBinding(tenantDb(env.DB, INSTALLATION), REPO.repo_id, "checks")).toMatchObject({ agent_id: mine.agentId });
  });

  it("asks for the agent id when two agents share the name", async () => {
    world.roles[LOGIN] = "admin";
    await seedAgent(INSTALLATION);
    await seedAgent(INSTALLATION);

    expect((await hookci(world, "bind acme/api builder")).text).toBe(S.slack.agentAmbiguous("builder"));
    expect(await getBinding(tenantDb(env.DB, INSTALLATION), REPO.repo_id, "checks")).toBeNull();
  });

  it("refuses a user with write access", async () => {
    world.roles[LOGIN] = "write";
    const agent = await seedAgent(INSTALLATION);

    expect((await hookci(world, `bind acme/api ${agent.agentId}`)).text).toBe(S.slack.forbidden);
    expect(await getBinding(tenantDb(env.DB, INSTALLATION), REPO.repo_id, "checks")).toBeNull();
  });

  it("rejects a target that is not checks or deploy:<env>", async () => {
    world.roles[LOGIN] = "admin";

    expect((await hookci(world, "bind acme/api builder staging")).text).toBe(S.slack.badTarget);
  });
});
