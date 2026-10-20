import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bind } from "../src/db/bindings";
import { upsertInstallation } from "../src/db/installations";
import { upsertRepos } from "../src/db/repos";
import { tenantDb } from "../src/db/tenant";
import { type CheckConclusion, latestDeployTrigger, onCheckConcluded } from "../src/deploy/chain";
import type { Env } from "../src/env";
import { checksSinkFactory } from "../src/sinks/checks";
import type { RunView } from "../src/sinks/types";
import type { TriggerRequest } from "../src/webhook/route";
import { clearTables } from "./db/helpers";
import { type Agent, type AgentSocket, connect, seedAgent } from "./do/agent-socket";
import { createFakeGitHub } from "./fakes/github";
import { generateAppKey } from "./github/helpers";

const INSTALLATION = 42;
const REPO = 1001;
const SHA = "a".repeat(40);

const PUSH_SUCCESS: CheckConclusion = {
  installationId: INSTALLATION,
  repo: "acme/widgets",
  sha: SHA,
  ref: "refs/heads/main",
  event: "push",
  conclusion: "success",
};

type Row = Record<string, unknown>;

function outbox(agent: Agent): Promise<Row[]> {
  return runInDurableObject(agent.stub, (dob) =>
    dob.sql
      .exec<{ frame: string }>("SELECT frame FROM outbox ORDER BY seq")
      .toArray()
      .map((row): Row => JSON.parse(row.frame)),
  );
}

async function deployRows(): Promise<Row[]> {
  return (await env.DB.prepare("SELECT * FROM deploy_triggers ORDER BY env, attempt").all<Row>()).results;
}

describe("deploy chain", () => {
  beforeEach(async () => {
    await clearTables();
    await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", created_at: 1 });
    await upsertRepos(tenantDb(env.DB, INSTALLATION), [{ repo_id: REPO, full_name: "acme/widgets", default_branch: "main" }]);
  });

  it("dispatches one trigger per env binding on push success", async () => {
    const t = tenantDb(env.DB, INSTALLATION);
    const staging = await seedAgent(INSTALLATION);
    const production = await seedAgent(INSTALLATION);
    await bind(t, REPO, "checks", staging.agentId);
    await bind(t, REPO, "deploy:staging", staging.agentId);
    await bind(t, REPO, "deploy:production", production.agentId);

    expect(await onCheckConcluded(env, PUSH_SUCCESS)).toBe(2);

    const rows = await deployRows();
    expect(rows).toHaveLength(2);
    for (const [agent, envName] of [
      [staging, "staging"],
      [production, "production"],
    ] as const) {
      const row = rows.find((r) => r.env === envName);
      expect(row).toMatchObject({ repo: "acme/widgets", sha: SHA, attempt: 1, event: "push", ref: "refs/heads/main", agent_id: agent.agentId, status: "sent", run_id: null });
      const frames = await outbox(agent);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ v: 1, type: "trigger", trigger_id: row?.trigger_id, repo: "acme/widgets", sha: SHA, ref: "refs/heads/main", event: "push", env: envName, attempt: 1, trust: "trusted" });
    }
    expect(await latestDeployTrigger(env, "acme/widgets", SHA, "staging")).toMatchObject({ env: "staging", attempt: 1 });
  });

  it("does not dispatch on failure, action_required or pull_request", async () => {
    const agent = await seedAgent(INSTALLATION);
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "deploy:staging", agent.agentId);

    expect(await onCheckConcluded(env, { ...PUSH_SUCCESS, conclusion: "failure" })).toBe(0);
    expect(await onCheckConcluded(env, { ...PUSH_SUCCESS, conclusion: "action_required" })).toBe(0);
    expect(await onCheckConcluded(env, { ...PUSH_SUCCESS, event: "pull_request" })).toBe(0);
    expect(await deployRows()).toEqual([]);
    expect(await outbox(agent)).toEqual([]);
  });

  it("redelivery is idempotent", async () => {
    const agent = await seedAgent(INSTALLATION);
    await bind(tenantDb(env.DB, INSTALLATION), REPO, "deploy:staging", agent.agentId);

    expect(await onCheckConcluded(env, PUSH_SUCCESS)).toBe(1);
    expect(await onCheckConcluded(env, PUSH_SUCCESS)).toBe(0);
    expect(await deployRows()).toHaveLength(1);
    expect(await outbox(agent)).toHaveLength(1);
  });

  describe("agent replies", () => {
    let sock: AgentSocket | undefined;
    afterEach(() => {
      sock?.ws.close();
      sock = undefined;
    });

    it("records accepted and rejected replies", async () => {
      const t = tenantDb(env.DB, INSTALLATION);
      const staging = await seedAgent(INSTALLATION);
      await bind(t, REPO, "deploy:staging", staging.agentId);
      await bind(t, REPO, "deploy:production", staging.agentId);
      sock = await connect(staging);
      expect(await sock.hello()).toMatchObject({ type: "welcome" });

      expect(await onCheckConcluded(env, PUSH_SUCCESS)).toBe(2);
      const first = await sock.next();
      const second = await sock.next();
      const byEnv = new Map([first, second].map((f) => [f.env, String(f.trigger_id)]));

      await sock.request({ type: "accepted", trigger_id: byEnv.get("staging"), run_id: "run_deploy_1" });
      await sock.request({ type: "rejected", trigger_id: byEnv.get("production"), reason: "deployments.production: not configured" });

      expect(await latestDeployTrigger(env, "acme/widgets", SHA, "staging")).toMatchObject({ status: "accepted", run_id: "run_deploy_1", reason: null });
      expect(await latestDeployTrigger(env, "acme/widgets", SHA, "production")).toMatchObject({
        status: "rejected",
        run_id: null,
        reason: "deployments.production: not configured",
      });
    });

    it("ignores non-deploy trigger ids", async () => {
      const agent = await seedAgent(INSTALLATION);
      await bind(tenantDb(env.DB, INSTALLATION), REPO, "checks", agent.agentId);
      sock = await connect(agent);
      expect(await sock.hello()).toMatchObject({ type: "welcome" });
      await bind(tenantDb(env.DB, INSTALLATION), REPO, "deploy:staging", agent.agentId);
      expect(await onCheckConcluded(env, PUSH_SUCCESS)).toBe(1);
      expect(await sock.next()).toMatchObject({ type: "trigger", env: "staging" });

      const ci: TriggerRequest = {
        installationId: INSTALLATION,
        repoId: REPO,
        repo: "acme/widgets",
        sha: "b".repeat(40),
        ref: "refs/heads/main",
        event: "push",
        authorLogin: "alice",
        commitTitle: "Fix",
        defaultBranch: "main",
        target: "checks",
        trust: "trusted",
      };
      const res = await agent.stub.fetch("https://do/trigger", { method: "POST", headers: { "x-zeroci-agent-id": agent.agentId }, body: JSON.stringify(ci) });
      const { trigger_id } = await res.json<{ trigger_id: string }>();
      const frame = await sock.next();
      expect(frame).toMatchObject({ type: "trigger", trigger_id });
      expect(frame).not.toHaveProperty("env");
      await sock.request({ type: "accepted", trigger_id, run_id: "run_ci_1" });

      expect(await deployRows()).toEqual([expect.objectContaining({ env: "staging", status: "sent", run_id: null })]);
      expect(await env.DB.prepare("SELECT state FROM runs WHERE run_id = 'run_ci_1'").first("state")).toBe("queued");
    });
  });

  describe("check conclusion", () => {
    const gh = createFakeGitHub();
    const saved = { fetcher: env.__TEST_FETCHER, key: env.GITHUB_APP_PRIVATE_KEY };
    let pem: string;

    beforeAll(async () => {
      pem = (await generateAppKey()).pem;
    });

    afterEach(() => {
      env.__TEST_FETCHER = saved.fetcher;
      env.GITHUB_APP_PRIVATE_KEY = saved.key;
      vi.restoreAllMocks();
    });

    it("chain error does not alter check conclusion", async () => {
      env.__TEST_FETCHER = gh.fetcher;
      env.GITHUB_APP_PRIVATE_KEY = pem;
      gh.respond("POST", "/app/installations/:id/access_tokens", () => Response.json({ token: "ghs_x", expires_at: "2030-01-01T00:00:00Z" }, { status: 201 }));
      gh.respond("POST", "/repos/:owner/:repo/check-runs", (req) => Response.json({ id: 7, ...(req.body as object) }, { status: 201 }));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      await bind(tenantDb(env.DB, INSTALLATION), REPO, "deploy:staging", "agt_unreachable");
      const broken: Env = {
        ...env,
        AGENT_DO: {
          idFromName: () => {
            throw new Error("agent namespace down");
          },
        } as unknown as Env["AGENT_DO"],
      };
      const run: RunView = {
        installationId: INSTALLATION,
        repoId: REPO,
        repo: "acme/widgets",
        triggerId: "trg_1",
        runId: "run_1",
        sha: SHA,
        shortSha: SHA.slice(0, 7),
        ref: "refs/heads/main",
        event: "push",
        target: "checks",
        state: "success",
        commitTitle: "Ship it",
        authorLogin: "alice",
        jobs: [],
      };

      await expect(checksSinkFactory(broken, INSTALLATION).onRunUpdate(run)).resolves.toBeUndefined();

      const posted = gh.calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs"));
      expect(posted).toHaveLength(1);
      expect(posted[0]?.body).toMatchObject({ name: "zeroci", status: "completed", conclusion: "success" });
      expect(errors.mock.calls.some(([line]) => typeof line === "string" && line.includes("agent namespace down"))).toBe(true);
      expect(await deployRows()).toEqual([]);
    });
  });
});
