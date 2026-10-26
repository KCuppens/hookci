import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { csrfForForm } from "../src/accounts/csrf";
import { getBinding } from "../src/db/bindings";
import { revokeAgent } from "../src/db/agents";
import { tenantDb } from "../src/db/tenant";
import { upsertRepos } from "../src/db/repos";
import { issueSession } from "../src/oauth/state";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { type CommandWorld, INSTALLATION, LOGIN, OTHER_INSTALLATION, REPO, setUpCommandWorld } from "./commands-helpers";
import { seedAgent } from "./do/agent-socket";

const ORIGIN = "https://hub.test";
const B = S.dashboard.reposPage.bindPage;
const PATH = `/${INSTALLATION}/repositories/bind`;

let world: CommandWorld;
let agentId: string;

beforeEach(async () => {
  world = await setUpCommandWorld();
  world.roles[LOGIN] = "admin";
  agentId = (await seedAgent(INSTALLATION)).agentId;
});

afterEach(() => world.restore());

async function sessionFor(installationIds: number[]): Promise<string> {
  const setCookie = await issueSession(env, { installationIds, githubUserId: 7001, githubLogin: LOGIN }, testClock.now());
  return setCookie.split(";")[0] ?? "";
}

interface PostOptions {
  installationId?: number;
  origin?: string | null;
  csrf?: "valid" | "wrong" | "none";
  fields?: Record<string, string>;
}

async function post(options: PostOptions = {}): Promise<Response> {
  const { token, cookie } = await csrfForForm(env, null);
  const cookies = [await sessionFor([INSTALLATION]), cookie?.split(";")[0] ?? null].filter((c) => c !== null);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", cookie: cookies.join("; ") };
  if (options.origin !== null) headers.origin = options.origin ?? env.HUB_ORIGIN;
  const csrf = options.csrf ?? "valid";
  const fields = { [`r${REPO.repo_id}`]: "1", kind: "checks", agent_id: agentId, ...options.fields };
  const body = new URLSearchParams(csrf === "none" ? {} : { csrf: csrf === "valid" ? token : `${token}x`, ...fields });
  return exports.default.fetch(`${ORIGIN}/${options.installationId ?? INSTALLATION}/repositories/bind`, { method: "POST", headers, body: body.toString(), redirect: "manual" });
}

async function bound(target: "checks" | `deploy:${string}`): Promise<string | null> {
  return (await getBinding(tenantDb(env.DB, INSTALLATION), REPO.repo_id, target))?.agent_id ?? null;
}

describe("GET /:installationId/repositories/bind", () => {
  it("shows the form with the repositories, the active agents and the picked repository ticked", async () => {
    await revokeAgent(tenantDb(env.DB, INSTALLATION), (await seedAgent(INSTALLATION)).agentId, 5);
    const res = await exports.default.fetch(`${ORIGIN}${PATH}?repo=${REPO.repo_id}`, { headers: { cookie: await sessionFor([INSTALLATION]) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(REPO.full_name);
    expect(html).toContain(`name="r${REPO.repo_id}" value="1" checked`);
    expect(html).toContain(`value="${agentId}"`);
    expect(html.match(/<option value="agt_/g)).toHaveLength(1);
    expect(html).toContain('name="csrf"');
  });

  it("answers 404 without a session and for an installation the session does not cover", async () => {
    expect((await exports.default.fetch(`${ORIGIN}${PATH}`)).status).toBe(404);
    const res = await exports.default.fetch(`${ORIGIN}/${OTHER_INSTALLATION}/repositories/bind`, { headers: { cookie: await sessionFor([INSTALLATION]) } });
    expect(res.status).toBe(404);
  });

  it("shows the notice after a bind", async () => {
    const res = await exports.default.fetch(`${ORIGIN}${PATH}?notice=bound`, { headers: { cookie: await sessionFor([INSTALLATION]) } });
    expect(await res.text()).toContain(B.notices.bound);
  });
});

describe("POST /:installationId/repositories/bind", () => {
  it("binds checks for a repository admin and redirects with the notice", async () => {
    const res = await post();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${PATH}?notice=bound`);
    expect(await bound("checks")).toBe(agentId);
  });

  it("binds a deploy environment", async () => {
    expect((await post({ fields: { kind: "deploy", env: "production" } })).status).toBe(303);
    expect(await bound("deploy:production")).toBe(agentId);
    expect(await bound("checks")).toBeNull();
  });

  it("refuses a malformed environment name", async () => {
    const res = await post({ fields: { kind: "deploy", env: "prod uction;" } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(B.badTarget);
  });

  it("refuses a login that is not admin on the repository, binding nothing", async () => {
    world.roles[LOGIN] = "write";
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(S.dashboard.reposPage.bindPage.notAdmin(REPO.full_name));
    expect(await bound("checks")).toBeNull();
  });

  it("binds several repositories to one agent in a single submission", async () => {
    await upsertRepos(tenantDb(env.DB, INSTALLATION), [{ repo_id: 902, full_name: "acme/second", default_branch: "main" }]);
    world.roles[LOGIN] = "admin";
    world.gh.respond("GET", "/repos/acme/second/collaborators/:login/permission", () => Response.json({ permission: "admin", role_name: "admin" }));
    const res = await post({ fields: { [`r${REPO.repo_id}`]: "1", r902: "1" } });
    expect(res.status).toBe(303);
    expect(await bound("checks")).toBe(agentId);
    expect((await getBinding(tenantDb(env.DB, INSTALLATION), 902, "checks"))?.agent_id).toBe(agentId);
  });

  it("binds nothing when one of several repositories is not admin", async () => {
    await upsertRepos(tenantDb(env.DB, INSTALLATION), [{ repo_id: 901, full_name: "acme/other", default_branch: "main" }]);
    world.roles[LOGIN] = "admin";
    world.gh.respond("GET", "/repos/acme/other/collaborators/:login/permission", () => Response.json({ permission: "read", role_name: "read" }));
    const res = await post({ fields: { r901: "1" } });
    expect(res.status).toBe(403);
    expect(await bound("checks")).toBeNull();
  });

  it("refuses without a csrf token, with a wrong one and from another origin", async () => {
    expect((await post({ csrf: "none" })).status).toBe(403);
    expect((await post({ csrf: "wrong" })).status).toBe(403);
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
    expect((await post({ origin: "https://hub.test.evil.test" })).status).toBe(403);
    expect(await bound("checks")).toBeNull();
  });

  it("answers 404 for an installation the session does not cover", async () => {
    const res = await post({ installationId: OTHER_INSTALLATION });
    expect(res.status).toBe(404);
    expect(await bound("checks")).toBeNull();
  });

  it("refuses a revoked agent, another installation's agent and an unknown one", async () => {
    await revokeAgent(tenantDb(env.DB, INSTALLATION), agentId, 5);
    const foreign = (await seedAgent(OTHER_INSTALLATION)).agentId;
    for (const id of [agentId, foreign, "agt_missing"]) {
      const res = await post({ fields: { agent_id: id } });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(B.badAgent);
    }
    expect(await bound("checks")).toBeNull();
  });

  it("refuses a repository of another installation", async () => {
    await upsertRepos(tenantDb(env.DB, OTHER_INSTALLATION), [{ repo_id: 777, full_name: "other/secret", default_branch: "main" }]);
    const res = await post({ fields: { [`r${REPO.repo_id}`]: "1", r777: "1" } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("other/secret");
    expect(await bound("checks")).toBeNull();
  });

  it("refuses more repositories than one submission may bind", async () => {
    const fields: Record<string, string> = {};
    for (let i = 1000; i < 1026; i++) fields[`r${i}`] = "1";
    const res = await post({ fields });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(B.tooMany(25));
  });
});
