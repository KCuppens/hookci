import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../../src/db/agents";
import { tenantDb } from "../../src/db/tenant";
import type { RunView } from "../../src/sinks/types";
import "../../src/index";
import { type HomeAgent, type HomeData, type HomeInstallation, loadHomeData, renderHome, upgradeHint } from "../../src/slack/home";
import { eventHandlerFor } from "../../src/slack/registry";
import { S } from "../../src/strings";
import { type CommandWorld, INSTALLATION, setUpCommandWorld, slackCalls, TEAM, USER } from "../commands-helpers";
import { fakeAgentNamespace } from "./agent-do";

function run(i: number, installationId: number): RunView {
  return {
    installationId,
    repoId: 900,
    repo: "acme/api",
    triggerId: `trg${i}`,
    runId: `run${i}`,
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    event: "push",
    target: `br${i}x`,
    state: "success",
    commitTitle: `Commit ${i}`,
    authorLogin: "octocat",
    durationMs: 1000,
    jobs: [{ name: "test", state: "success" }],
  };
}

function agent(agentId: string, status: HomeAgent["status"], over: Partial<HomeAgent> = {}): HomeAgent {
  return { agentId, installationId: 1, name: agentId, lastSeenAt: 1_700_000_000_000, lastSeen: 1_700_000_000_000, hostname: `${agentId}.local`, agentVersion: "0.1.0", status, ...over };
}

function installation(id: number, over: Partial<HomeInstallation> = {}): HomeInstallation {
  return {
    id,
    accountLogin: `acct${id}`,
    isAdmin: false,
    agents: [agent(`a${id}on`, "online"), agent(`a${id}off`, "offline"), agent(`a${id}rev`, "revoked")],
    repos: [{ fullName: "acme/api", channels: ["C1"] }],
    recentRuns: Array.from({ length: 12 }, (_, i) => run(i, id)),
    ...over,
  };
}

const json = (data: HomeData) => JSON.stringify(renderHome(data));

describe("renderHome", () => {
  it("renders 10 runs per installation, agent states and no admin buttons for non-admins", () => {
    const view = renderHome({ linked: true, installations: [installation(1), installation(2)] });
    const text = JSON.stringify(view);
    const runLines = view.blocks.filter((b) => JSON.stringify(b).includes("aaaaaaa"));
    expect(runLines.length).toBe(20);
    expect(text).toContain("br9x");
    expect(text).not.toContain("br10x");
    expect(text).toContain(":large_green_circle:");
    expect(text).toContain(":black_circle:");
    expect(text).toContain(":white_circle:");
    expect(text).not.toContain("home:add_agent");
    expect(text).not.toContain("home:revoke_agent");
    expect(text).toContain("home:refresh");
  });

  it("shows Add agent and Revoke with a confirm to admins, not for revoked agents", () => {
    const text = json({ linked: true, installations: [installation(1, { isAdmin: true })] });
    expect(text).toContain('"action_id":"home:add_agent"');
    expect(text).toContain('"value":"1"');
    expect(text).toContain("home:revoke_agent:a1on");
    expect(text).toContain("home:revoke_agent:a1off");
    expect(text).not.toContain("home:revoke_agent:a1rev");
    expect(text).toContain('"confirm"');
  });

  it("caps at 100 blocks and ends with the truncation note", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      installation(i + 1, { repos: Array.from({ length: 8 }, (_, r) => ({ fullName: `acme/r${r}`, channels: ["C1"] })) }),
    );
    const view = renderHome({ linked: true, installations: many });
    expect(view.blocks.length).toBeLessThanOrEqual(100);
    expect(view.blocks.at(-1)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: S.home.truncated }] });
  });

  it("prompts unlinked users to link", () => {
    const text = json({ linked: false, installations: [] });
    expect(text).toContain("/hookci me");
  });

  it("leads with the notice and still caps at 100 blocks", () => {
    const notice = { type: "section", text: { type: "mrkdwn", text: S.slack.forbidden } };
    expect(renderHome({ linked: true, installations: [installation(1)] }, S.slack.forbidden).blocks[0]).toEqual(notice);
    const many = Array.from({ length: 12 }, (_, i) =>
      installation(i + 1, { repos: Array.from({ length: 8 }, (_, r) => ({ fullName: `acme/r${r}`, channels: ["C1"] })) }),
    );
    const view = renderHome({ linked: true, installations: many }, S.slack.forbidden);
    expect(view.blocks[0]).toEqual(notice);
    expect(view.blocks.length).toBeLessThanOrEqual(100);
  });

  it("has no em-dash or emoji code points", () => {
    const text = json({ linked: false, installations: [installation(1, { isAdmin: true, agents: [agent("x", "offline", { upgradeHint: upgradeHint(0, null, "0.2.0") })] })] });
    expect(text).not.toContain("\u2014");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("upgradeHint", () => {
  it("hints for an old protocol or an agent older than the recommended version", () => {
    expect(upgradeHint(0, "0.3.0", "v0.3.0")).toBe(S.home.upgradeAvailable("v0.3.0"));
    expect(upgradeHint(1, "0.1.0", "v0.2.0")).toBe(S.home.upgradeAvailable("v0.2.0"));
    expect(upgradeHint(1, "0.3.0", "v0.3.1")).toBe(S.home.upgradeAvailable("v0.3.1"));
    expect(upgradeHint(1, "0.3.0-rc.1", "v0.3.0")).toBe(S.home.upgradeAvailable("v0.3.0"));
    expect(upgradeHint(1, "0.2.0", "v0.2.0")).toBeUndefined();
    expect(upgradeHint(1, "v0.4.0", "v0.3.0")).toBeUndefined();
    expect(upgradeHint(null, null, "v0.2.0")).toBeUndefined();
    expect(upgradeHint(1, "dev", "v0.2.0")).toBeUndefined();
  });

  it("gives no version hint when the hub names no recommended version", () => {
    expect(upgradeHint(1, "0.1.0", "")).toBeUndefined();
    expect(upgradeHint(0, "0.1.0", "")).toBe("upgrade available: run sudo hookci upgrade");
  });
});

describe("with the database", () => {
  let world: CommandWorld;
  let restoreDo: () => void;
  beforeEach(async () => {
    world = await setUpCommandWorld();
    world.gh.respond("GET", "/orgs/:org/memberships/:login", () => Response.json({ message: "Not Found" }, { status: 404 }));
    world.slack.respond("POST", "/api/views.publish", () => Response.json({ ok: true }));
  });
  afterEach(() => {
    restoreDo();
    world.restore();
  });

  it("falls back to the D1 status when the AgentDO never answers", async () => {
    restoreDo = fakeAgentNamespace({ hang: true }).restore;
    const t = tenantDb(env.DB, INSTALLATION);
    await insertAgent(t, { agent_id: "agt_1", name: "box", hostname: "box.local", os: "linux", arch: "amd64", credential_hash: "h", agent_version: "0.1.0", paired_by_github_id: 7001, paired_at: 1 });
    await env.DB.prepare("UPDATE agents SET status = 'online', last_seen_at = 5 WHERE agent_id = 'agt_1'").run();
    const data = await loadHomeData(env, TEAM, USER);
    expect(data.installations[0]?.agents[0]).toMatchObject({ agentId: "agt_1", status: "online", hostname: "box.local" });
  });

  it("hints against LATEST_AGENT_VERSION, not HUB_VERSION, and not at all when it is empty", async () => {
    // The AgentDO stub reports agent_version 0.1.0 on the current protocol.
    restoreDo = fakeAgentNamespace({}).restore;
    const t = tenantDb(env.DB, INSTALLATION);
    await insertAgent(t, { agent_id: "agt_1", name: "box", hostname: "box.local", os: "linux", arch: "amd64", credential_hash: "h", agent_version: "0.1.0", paired_by_github_id: 7001, paired_at: 1 });
    const hint = async (latest: string) =>
      (await loadHomeData({ ...env, LATEST_AGENT_VERSION: latest, HUB_VERSION: "9.9.0" }, TEAM, USER)).installations[0]?.agents[0]?.upgradeHint;
    expect(await hint("v0.3.0")).toBe("upgrade available (v0.3.0): run sudo hookci upgrade");
    expect(await hint("v0.1.0")).toBeUndefined();
    expect(await hint("")).toBeUndefined();
  });

  it("app_home_opened publishes only for the home tab", async () => {
    restoreDo = fakeAgentNamespace({}).restore;
    const handler = eventHandlerFor("app_home_opened");
    expect(handler).toBeDefined();
    await handler?.(env, TEAM, { type: "app_home_opened", user: USER, tab: "messages" });
    expect(slackCalls(world, "views.publish").length).toBe(0);
    await handler?.(env, TEAM, { type: "app_home_opened", user: USER, tab: "home" });
    const calls = slackCalls(world, "views.publish");
    expect(calls.length).toBe(1);
    expect(calls[0]?.body).toMatchObject({ user_id: USER });
  });
});
