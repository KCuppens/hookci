import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { agentCredentialHash } from "../src/db/agents";
import { upsertInstallation } from "../src/db/installations";
import { upsertRepos } from "../src/db/repos";
import { tenantDb } from "../src/db/tenant";
import { revokeAgent } from "../src/pairing/agents";
import { PAIR_TOKEN_TTL_MS, type RedeemResult, createPairToken } from "../src/pairing/tokens";
import { type TriggerRequest, routeTrigger } from "../src/webhook/route";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { type Agent, AgentSocket, connect, connectRequest, seedAgent } from "./do/agent-socket";

const INSTALLATION = 42;
const ADMIN = 7;
const REPOS = [
  { repo_id: 1001, full_name: "acme/widgets", default_branch: "main" },
  { repo_id: 1002, full_name: "acme/gadgets", default_branch: "main" },
];

function redeemRequest(pairToken: string, ip = "203.0.113.9"): Promise<Response> {
  return exports.default.fetch("https://hub.test/v1/pair/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ pair_token: pairToken, name: "builder", hostname: "builder.local", agent_version: "1.4.0", os: "linux", arch: "amd64" }),
  });
}

async function newToken(replacesAgentId?: string): Promise<string> {
  const { token } = await createPairToken(env, { installationId: INSTALLATION, createdByGithubId: ADMIN, replacesAgentId });
  return token;
}

async function pair(token?: string): Promise<RedeemResult> {
  const res = await redeemRequest(token ?? (await newToken()));
  expect(res.status).toBe(200);
  return res.json<RedeemResult>();
}

async function bindings(): Promise<{ repo_id: number; target: string; agent_id: string }[]> {
  const { results } = await env.DB.prepare("SELECT repo_id, target, agent_id FROM repo_bindings ORDER BY repo_id").all<{
    repo_id: number;
    target: string;
    agent_id: string;
  }>();
  return results;
}

function agentOf(result: RedeemResult): Agent {
  return { agentId: result.agent_id, credential: result.credential, stub: env.AGENT_DO.get(env.AGENT_DO.idFromName(result.agent_id)) };
}

beforeEach(async () => {
  await clearTables();
  await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", account_id: INSTALLATION * 10, created_at: 1 });
  await upsertRepos(tenantDb(env.DB, INSTALLATION), REPOS);
});

describe("pairing", () => {
  it("redeem creates agent and returns credential once", async () => {
    const token = await newToken();
    const res = await redeemRequest(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<RedeemResult>();
    expect(body).toEqual({
      agent_id: expect.stringMatching(/^agt_[0-9a-z]{26}$/),
      credential: expect.stringMatching(/^zc_agent_[a-z2-7]+$/),
      installation_id: INSTALLATION,
      hub_ws_url: `${env.HUB_ORIGIN.replace(/^http/, "ws")}/v1/agent/connect`,
      name: "builder",
    });

    const row = await env.DB.prepare("SELECT * FROM agents WHERE agent_id = ?1").bind(body.agent_id).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      installation_id: INSTALLATION,
      name: "builder",
      hostname: "builder.local",
      os: "linux",
      arch: "amd64",
      agent_version: "1.4.0",
      credential_hash: await agentCredentialHash(body.credential),
      paired_by_github_id: ADMIN,
      status: "offline",
      revoked_at: null,
    });
    const dump = JSON.stringify(
      await Promise.all(["agents", "pair_tokens"].map((t) => env.DB.prepare(`SELECT * FROM ${t}`).all().then((r) => r.results))),
    );
    expect(dump).not.toContain(body.credential);
    expect(dump).not.toContain(token);
    expect(await env.DB.prepare("SELECT token_hash FROM pair_tokens").first("token_hash")).toBe(await sha256Hex(token));

    expect((await connectRequest(body.credential)).status).toBe(101);
  });

  it("token is single use", async () => {
    const token = await newToken();
    await pair(token);
    const again = await redeemRequest(token);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_pair_token" });

    const raced = await newToken();
    const results = await Promise.all([redeemRequest(raced), redeemRequest(raced)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const { n } = (await env.DB.prepare("SELECT count(*) AS n FROM agents").first<{ n: number }>())!;
    expect(n).toBe(2);
  });

  it("expired token rejected", async () => {
    const fresh = await newToken();
    const stale = await newToken();
    testClock.advance(PAIR_TOKEN_TTL_MS - 60_000);
    expect((await redeemRequest(fresh)).status).toBe(200);
    testClock.advance(60_000);
    const res = await redeemRequest(stale);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_pair_token" });
  });

  it("unknown, used and expired tokens return identical bodies", async () => {
    const used = await newToken();
    await pair(used);
    const expired = await newToken();
    testClock.advance(PAIR_TOKEN_TTL_MS);
    const responses = await Promise.all([redeemRequest("zc_pair_doesnotexist"), redeemRequest(used), redeemRequest(expired)]);
    const bodies = await Promise.all(responses.map((r) => r.text()));
    expect(responses.map((r) => r.status)).toEqual([400, 400, 400]);
    expect(bodies).toEqual(Array(3).fill('{"error":"invalid_pair_token"}'));
  });

  it("first agent gets all repos", async () => {
    const first = await pair();
    expect(await bindings()).toEqual(REPOS.map((r) => ({ repo_id: r.repo_id, target: "checks", agent_id: first.agent_id })));
    const second = await pair();
    expect(second.agent_id).not.toBe(first.agent_id);
    expect(await bindings()).toEqual(REPOS.map((r) => ({ repo_id: r.repo_id, target: "checks", agent_id: first.agent_id })));
  });

  it("agent limit", async () => {
    for (let i = 0; i < 10; i++) await seedAgent(INSTALLATION);
    const res = await redeemRequest(await newToken());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "agent_limit" });
    const { n } = (await env.DB.prepare("SELECT count(*) AS n FROM agents").first<{ n: number }>())!;
    expect(n).toBe(10);
  });

  it("pair token issuance rate limit", async () => {
    for (let i = 0; i < 10; i++) await newToken();
    await expect(newToken()).rejects.toMatchObject({ code: "pair_rate_limited", status: 429 });
    testClock.advance(60 * 60_000);
    await expect(newToken()).resolves.toMatch(/^zc_pair_/);
  });

  it("re-pair rotates credential and interrupts runs", async () => {
    const paired = await pair();
    const agent = agentOf(paired);
    const sock = await connect(agent);
    await sock.hello();
    const trig = await agent.stub.fetch("https://do/trigger", {
      method: "POST",
      headers: { "x-zeroci-agent-id": agent.agentId },
      body: JSON.stringify({
        installationId: INSTALLATION,
        repoId: 1001,
        repo: "acme/widgets",
        sha: "1".repeat(40),
        ref: "refs/heads/feature",
        event: "push",
        authorLogin: "alice",
        commitTitle: "Add widget sizing",
        defaultBranch: "main",
        target: "checks",
        trust: "trusted",
      } satisfies TriggerRequest),
    });
    expect(trig.status).toBe(202);
    const { trigger_id } = await trig.json<{ trigger_id: string }>();
    expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id });
    expect(await sock.request({ type: "accepted", trigger_id, run_id: "run_a" })).toEqual([]);

    const repaired = await pair(await newToken(agent.agentId));
    expect(repaired.agent_id).toBe(agent.agentId);
    expect(repaired.credential).not.toBe(agent.credential);

    expect(await sock.next()).toMatchObject({ type: "interrupt", run_id: "run_a", reason: "repair" });
    expect(await sock.closed).toMatchObject({ code: 4000 });
    const old = await connectRequest(agent.credential);
    expect(old.status).toBe(401);
    expect((await connectRequest(repaired.credential)).status).toBe(101);
    const { n } = (await env.DB.prepare("SELECT count(*) AS n FROM agents").first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("revoke removes bindings and closes socket", async () => {
    const paired = await pair();
    const sock: AgentSocket = await connect(agentOf(paired));
    await sock.hello();

    await revokeAgent(env, paired.agent_id, "revoked");

    expect(await sock.next()).toMatchObject({ type: "error", code: "revoked" });
    expect(await sock.closed).toMatchObject({ code: 4401 });
    expect(await bindings()).toEqual([]);
    expect(await env.DB.prepare("SELECT status FROM agents WHERE agent_id = ?1").bind(paired.agent_id).first("status")).toBe("revoked");
    const reconnect = await connectRequest(paired.credential);
    expect(reconnect.status).toBe(401);

    const ctx = createExecutionContext();
    const outcome = await routeTrigger(
      env,
      {
        installationId: INSTALLATION,
        repoId: 1001,
        repo: "acme/widgets",
        sha: "2".repeat(40),
        ref: "refs/heads/main",
        event: "push",
        authorLogin: "alice",
        commitTitle: "Ship it",
        defaultBranch: "main",
        target: "checks",
      },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(outcome).toEqual({ kind: "no_agent" });
  });

  it("redeem per-IP limit", async () => {
    for (let i = 0; i < 20; i++) expect((await redeemRequest(`zc_pair_guess${i}`, "198.51.100.4")).status).toBe(400);
    const limited = await redeemRequest(await newToken(), "198.51.100.4");
    expect(limited.status).toBe(429);
    expect((await redeemRequest(await newToken(), "198.51.100.5")).status).toBe(200);
  });
});
