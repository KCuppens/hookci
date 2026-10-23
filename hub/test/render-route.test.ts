import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { bind } from "../src/db/bindings";
import { upsertInstallation } from "../src/db/installations";
import { upsertRepos } from "../src/db/repos";
import { tenantDb } from "../src/db/tenant";
import { renderDeployBadge } from "../src/deploy/render";
import type { RenderRequest } from "../src/protocol";
import { clearTables } from "./db/helpers";
import { seedAgent } from "./logs/helpers";

const INSTALLATION = 61;
const OTHER = 62;
const SHA = "d".repeat(40);
const VALID: RenderRequest = { v: 1, kind: "deploy_badge", repo: "acme/api", env: "staging", sha: SHA, state: "running" };

let agent: string;
let stranger: string;

beforeEach(async () => {
  await clearTables();
  for (const id of [INSTALLATION, OTHER]) {
    await upsertInstallation(env.DB, { id, account_login: `acct${id}`, account_type: "Organization", account_id: id * 10, created_at: 1 });
  }
  const t = tenantDb(env.DB, INSTALLATION);
  await upsertRepos(t, [
    { repo_id: 6100, full_name: "acme/api", default_branch: "main" },
    { repo_id: 6101, full_name: "acme/web", default_branch: "main" },
  ]);
  agent = await seedAgent(INSTALLATION, "agt_render");
  stranger = await seedAgent(OTHER, "agt_render_other");
  await bind(t, 6100, "deploy:staging", "agt_render");
});

function render(body: unknown, credential: string | null = agent): Promise<Response> {
  return exports.default.fetch("https://hub.test/v1/render", {
    method: "POST",
    headers: { "content-type": "application/json", ...(credential === null ? {} : { authorization: `Bearer ${credential}` }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /v1/render", () => {
  it("render route ok", async () => {
    const res = await render(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ v: 1, ...renderDeployBadge({ env: "staging", sha: SHA, state: "running" }) });

    const failed: RenderRequest = { ...VALID, state: "failed", step: "migrate", step_index: 2, steps_total: 8, duration_ms: 124_000 };
    const badge = renderDeployBadge({ env: "staging", sha: SHA, state: "failed", step: "migrate", stepIndex: 2, stepsTotal: 8, durationMs: 124_000 });
    const body = (await (await render(failed)).json()) as { text: string; blocks: unknown[] };
    expect(body).toEqual({ v: 1, text: badge.text, blocks: badge.blocks });
    expect(body.text).toBe("staging · ddddddd · failed at 3/8 migrate");
  });

  it("render route auth", async () => {
    const missing = await render(VALID, null);
    expect(missing.status).toBe(401);
    expect(await render(VALID, "hci_agent_nobody")).toMatchObject({ status: 401 });

    const unbound = await render({ ...VALID, repo: "acme/web" });
    expect(unbound.status).toBe(403);
    expect(await unbound.json()).toEqual({ error: "forbidden" });
    expect((await render(VALID, stranger)).status).toBe(403);

    const { env: _env, ...noEnv } = VALID;
    const invalid = await render(noEnv);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ v: 1, error: "env: required" });
  });

  it.each([
    ["not json", "body: must be a JSON object"],
    [{ ...VALID, extra: 1 }, "extra: unknown field"],
    [{ ...VALID, v: 2 }, "v: must be 1"],
    [{ ...VALID, kind: "badge" }, "kind: must be deploy_badge"],
    [{ ...VALID, repo: "acme" }, "repo: must be owner/name"],
    [{ ...VALID, env: "Staging" }, "env: must match ^[a-z][a-z0-9-]{0,31}$"],
    [{ ...VALID, sha: "ABC" }, "sha: must be 40 lowercase hex characters"],
    [{ ...VALID, state: "done" }, "state: must be one of queued, running, rolling_back, succeeded, failed"],
    [{ ...VALID, step: 3 }, "step: must be a string"],
    [{ ...VALID, step_index: -1 }, "step_index: must be an integer >= 0"],
    [{ ...VALID, steps_total: 0 }, "steps_total: must be an integer >= 1"],
    [{ ...VALID, duration_ms: 1.5 }, "duration_ms: must be an integer >= 0"],
  ])("answers 400 for %j", async (body, error) => {
    const res = await render(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ v: 1, error });
  });
});
