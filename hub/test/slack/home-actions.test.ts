import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../../src/db/agents";
import { upsertInstallation } from "../../src/db/installations";
import { tenantDb } from "../../src/db/tenant";
import "../../src/index";
import { createPairToken } from "../../src/pairing/tokens";
import { QUOTAS } from "../../src/quotas";
import { actionFor } from "../../src/slack/registry";
import { S } from "../../src/strings";
import { type CommandWorld, INSTALLATION, LOGIN, OTHER_INSTALLATION, setUpCommandWorld, slackCalls, TEAM, USER } from "../commands-helpers";
import { type FakeAgentNamespace, fakeAgentNamespace } from "./agent-do";

let world: CommandWorld;
let agents: FakeAgentNamespace;
let admins: Set<string>;

beforeEach(async () => {
  world = await setUpCommandWorld();
  admins = new Set();
  world.gh.respond("GET", "/orgs/:org/memberships/:login", ({ params }) =>
    admins.has(params.login ?? "") ? Response.json({ state: "active", role: "admin" }) : Response.json({ message: "Not Found" }, { status: 404 }),
  );
  world.slack.respond("POST", "/api/views.open", () => Response.json({ ok: true }));
  world.slack.respond("POST", "/api/views.publish", () => Response.json({ ok: true }));
  agents = fakeAgentNamespace({});
});

afterEach(() => {
  agents.restore();
  world.restore();
});

function press(actionId: string, value: string) {
  const handler = actionFor(actionId);
  if (!handler) throw new Error(`no handler for ${actionId}`);
  return handler({ env, teamId: TEAM, userId: USER, actionId, value, responseUrl: null, triggerId: "1.2.trig" });
}

/** Presses actionId on the Home tab through SlackWorkspaceDO and returns the first block of each Home view it published for USER. */
async function pressOnHome(actionId: string, value: string): Promise<unknown[]> {
  const before = slackCalls(world, "views.publish").length;
  const body = { teamId: TEAM, userId: USER, actionId, value, responseUrl: null, triggerId: "1.2.trig", view: { type: "home" } };
  const res = await env.SLACK_DO.get(env.SLACK_DO.idFromName(TEAM)).fetch("https://do/action", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(204);
  return slackCalls(world, "views.publish")
    .slice(before)
    .map((call) => {
      expect(call.body).toMatchObject({ user_id: USER, view: expect.any(String) });
      // Checked just above: the fake parsed the form body and the view is a JSON string.
      const sent = call.body as { view: string };
      const view: unknown = JSON.parse(sent.view);
      expect(view).toMatchObject({ type: "home", blocks: expect.any(Array) });
      // Checked just above: a home view with a blocks array.
      const home = view as { blocks: unknown[] };
      return home.blocks[0];
    });
}

const notice = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });

async function pairTokens(): Promise<number> {
  return (await env.DB.prepare("SELECT count(*) AS n FROM pair_tokens").first<{ n: number }>())?.n ?? 0;
}

async function seedAgent(installationId: number, agentId: string): Promise<void> {
  await insertAgent(tenantDb(env.DB, installationId), {
    agent_id: agentId,
    name: agentId,
    hostname: `${agentId}.local`,
    os: "linux",
    arch: "amd64",
    credential_hash: `hash_${agentId}`,
    agent_version: "0.1.0",
    paired_by_github_id: 7001,
    paired_at: 1,
  });
  await env.DB.prepare("UPDATE agents SET status = 'online' WHERE agent_id = ?1").bind(agentId).run();
}

async function agentStatus(agentId: string): Promise<string | undefined> {
  return (await env.DB.prepare("SELECT status FROM agents WHERE agent_id = ?1").bind(agentId).first<{ status: string }>())?.status;
}

describe("home:add_agent", () => {
  it("opens the pair token modal for an org admin", async () => {
    admins.add(LOGIN);
    expect(await press("home:add_agent", String(INSTALLATION))).toBeNull();
    const opens = slackCalls(world, "views.open");
    expect(opens.length).toBe(1);
    const body = opens[0]?.body as { trigger_id: string; view: string };
    expect(body.trigger_id).toBe("1.2.trig");
    expect(body.view).toContain("zc_pair_");
    expect(body.view).toContain(`curl -fsSL ${env.HUB_ORIGIN}/install | sh`);
    expect(body.view).toContain("sudo zeroci connect zc_pair_");
    expect(await pairTokens()).toBe(1);
  });

  it("refuses a non-admin without creating a token", async () => {
    expect(await press("home:add_agent", String(INSTALLATION))).toEqual({ response_type: "ephemeral", text: S.slack.forbidden });
    expect(await pressOnHome("home:add_agent", String(INSTALLATION))).toEqual([notice(S.slack.forbidden)]);
    expect(slackCalls(world, "views.open").length).toBe(0);
    expect(await pairTokens()).toBe(0);
  });

  it("answers slow down and opens no modal when pair tokens are rate limited", async () => {
    admins.add(LOGIN);
    for (let i = 0; i < QUOTAS.pairTokensPerHour; i++) await createPairToken(env, { installationId: INSTALLATION, createdByGithubId: 7001 });
    expect(await press("home:add_agent", String(INSTALLATION))).toEqual({ response_type: "ephemeral", text: S.slack.slowDown });
    expect(await pressOnHome("home:add_agent", String(INSTALLATION))).toEqual([notice(S.slack.slowDown)]);
    expect(slackCalls(world, "views.open").length).toBe(0);
  });

  it("on a personal account admits the owner by GitHub user id, not by login", async () => {
    // The login matches but belongs to a new holder after a rename: refused.
    await upsertInstallation(env.DB, { id: INSTALLATION, account_login: LOGIN, account_type: "User", account_id: 9999, created_at: 1 });
    expect(await press("home:add_agent", String(INSTALLATION))).toEqual({ response_type: "ephemeral", text: S.slack.forbidden });
    expect(await pairTokens()).toBe(0);

    // The owner renamed away from the stored login but keeps the account id: admitted.
    await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "old-login", account_type: "User", account_id: 7001, created_at: 1 });
    expect(await press("home:add_agent", String(INSTALLATION))).toBeNull();
    expect(await pairTokens()).toBe(1);
  });
});

describe("home:revoke_agent", () => {
  it("refuses another installation's agent", async () => {
    admins.add(LOGIN);
    await seedAgent(OTHER_INSTALLATION, "agt_other");
    for (const value of [String(INSTALLATION), String(OTHER_INSTALLATION)]) {
      expect(await press("home:revoke_agent:agt_other", value)).toEqual({ response_type: "ephemeral", text: S.slack.forbidden });
      expect(await pressOnHome("home:revoke_agent:agt_other", value)).toEqual([notice(S.slack.forbidden)]);
    }
    expect(await agentStatus("agt_other")).toBe("online");
    expect(agents.revoked).toEqual([]);
  });

  it("refuses a non-admin", async () => {
    await seedAgent(INSTALLATION, "agt_own");
    expect(await press("home:revoke_agent:agt_own", String(INSTALLATION))).toEqual({ response_type: "ephemeral", text: S.slack.forbidden });
    expect(await pressOnHome("home:revoke_agent:agt_own", String(INSTALLATION))).toEqual([notice(S.slack.forbidden)]);
    expect(await agentStatus("agt_own")).toBe("online");
  });

  it("revokes an own agent and republishes the Home tab", async () => {
    admins.add(LOGIN);
    await seedAgent(INSTALLATION, "agt_own");
    expect(await press("home:revoke_agent:agt_own", String(INSTALLATION))).toBeNull();
    expect(await agentStatus("agt_own")).toBe("revoked");
    expect(agents.revoked).toEqual(["agt_own"]);
    expect(slackCalls(world, "views.publish").length).toBe(1);
  });

  it("republishes without a notice when the action has nothing to say", async () => {
    expect(await pressOnHome("home:refresh", "refresh")).toEqual([expect.objectContaining({ type: "header" })]);
  });
});
