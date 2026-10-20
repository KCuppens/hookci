import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertRepos } from "../../src/db/repos";
import { tenantDb } from "../../src/db/tenant";
import type { Clock } from "../../src/do/clock";
import worker from "../../src/index";
import { QUOTAS } from "../../src/quotas";
import { clearTables } from "../db/helpers";
import { seedTenant, type Tenant } from "../helpers/tenants";

const HOOK = "https://hooks.example.com/zeroci";

let a: Tenant;
let b: Tenant;
let at = 0;
const clock: Clock = { now: () => at };
let posts: number;
const saved = { fetcher: env.__TEST_FETCHER, clock: env.__TEST_CLOCK };

beforeEach(async () => {
  await clearTables();
  a = await seedTenant(env, { installationId: 81, teamId: "T081" });
  b = await seedTenant(env, { installationId: 82, teamId: "T082" });
  // The start of an hour, so every write of a test lands in one quota window.
  at = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 1000;
  posts = 0;
  env.__TEST_CLOCK = clock;
  env.__TEST_FETCHER = async () => {
    posts++;
    return new Response(null, { status: 200 });
  };
});

afterEach(() => {
  env.__TEST_FETCHER = saved.fetcher;
  env.__TEST_CLOCK = saved.clock;
});

async function call(method: string, path: string, credential: string | null, body?: unknown): Promise<Response> {
  const headers = new Headers();
  if (credential !== null) headers.set("authorization", `Bearer ${credential}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://hub.test${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const addHook = (t: Tenant, url = HOOK) => call("POST", "/v1/agent/sinks", t.credential, { kind: "webhook", repo: t.fullName, url, label: "builds" });

describe("/v1/agent/sinks", () => {
  it("adds, lists, tests and removes a webhook sink", async () => {
    const added = await addHook(a);
    expect(added.status).toBe(201);
    const { sink, generated_secret } = await added.json<{ sink: { id: string }; generated_secret: string }>();
    expect(generated_secret).toMatch(/^zcwh_/);
    expect(sink).toMatchObject({ kind: "webhook", repo: a.fullName, label: "builds", target: HOOK, disabled_at: null, last_error: null });

    const listed = await call("GET", `/v1/agent/sinks?repo=${a.fullName}`, a.credential);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ sinks: [sink] });

    const tested = await call("POST", `/v1/agent/sinks/${sink.id}/test`, a.credential);
    expect(tested.status).toBe(200);
    expect(await tested.json()).toEqual({ result: "ok" });
    expect(posts).toBe(1);

    const removed = await call("DELETE", `/v1/agent/sinks/${sink.id}`, a.credential);
    expect(removed.status).toBe(204);
    expect(await (await call("GET", `/v1/agent/sinks?repo=${a.fullName}`, a.credential)).json()).toEqual({ sinks: [] });
  });

  it("adds a Telegram sink from snake_case fields", async () => {
    env.__TEST_FETCHER = async (input) =>
      Response.json({ ok: true, result: String(input).endsWith("/getMe") ? { id: 1, is_bot: true, username: "bot" } : { id: -100, type: "group", title: "CI" } });
    const res = await call("POST", "/v1/agent/sinks", a.credential, { kind: "telegram", repo: a.fullName, bot_token: "123:abc", chat_id: "-100" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sink: expect.objectContaining({ kind: "telegram", target: "chat -100", label: null }) });
  });

  it("adds a Linear sink from snake_case fields and refuses a Telegram field on it", async () => {
    const apiKey = "lin_api_ROUTEKEY42";
    env.__TEST_FETCHER = async (_input, init) => {
      const query = String(JSON.parse(String(init?.body)).query);
      if (query.includes("teams(")) return Response.json({ data: { teams: { nodes: [{ id: "team_1", key: "ENG" }] } } });
      if (query.includes("users(")) return Response.json({ data: { users: { nodes: [{ id: "usr_1", name: "Ada", url: "https://linear.app/u/ada" }] } } });
      if (query.includes("team(")) return Response.json({ data: { team: { states: { nodes: [] } } } });
      return Response.json({ data: { viewer: { id: "me" } } });
    };
    const body = { kind: "linear", repo: a.fullName, api_key: apiKey, team_key: "ENG", assignee_email: "ada@example.com", label: "deploys" };
    const res = await call("POST", "/v1/agent/sinks", a.credential, body);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(apiKey);
    expect(JSON.parse(text)).toEqual({ sink: expect.objectContaining({ kind: "linear", target: { teamKey: "ENG", assigneeName: "Ada" }, label: "deploys" }) });

    const withChat = await call("POST", "/v1/agent/sinks", a.credential, { ...body, chat_id: "-100" });
    expect(withChat.status).toBe(400);
    expect(await withChat.json()).toMatchObject({ error: "invalid", message: "chat_id: not a linear field" });
  });

  it("answers 400 with the code and message of a refused config", async () => {
    const res = await addHook(a, "http://hooks.example.com/x");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "not_https", message: "The webhook URL must start with https://." });

    const unknownField = await call("POST", "/v1/agent/sinks", a.credential, { kind: "webhook", repo: a.fullName, url: HOOK, bot_token: "1:x" });
    expect(unknownField.status).toBe(400);
    expect(await unknownField.json()).toMatchObject({ error: "invalid", message: "bot_token: not a webhook field" });

    const notJson = await call("POST", "/v1/agent/sinks", a.credential, "{");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: "invalid" });

    const badRepo = await call("GET", "/v1/agent/sinks", a.credential);
    expect(badRepo.status).toBe(400);
    expect(await badRepo.json()).toMatchObject({ error: "invalid_repo" });
  });

  it("answers 401 without a valid agent credential", async () => {
    for (const credential of [null, "zc_agent_forged"]) {
      const res = await call("GET", `/v1/agent/sinks?repo=${a.fullName}`, credential);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "auth_failed" });
    }
  });

  it("answers 403 repo_not_bound for a repo with no binding", async () => {
    await upsertRepos(tenantDb(env.DB, a.installationId), [{ repo_id: 8101, full_name: "org81/unbound", default_branch: "main" }]);
    const res = await call("POST", "/v1/agent/sinks", a.credential, { kind: "webhook", repo: "org81/unbound", url: HOOK });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "repo_not_bound" });
  });

  it("answers 404 for another installation's sink", async () => {
    const { sink } = await (await addHook(a)).json<{ sink: { id: string } }>();
    expect((await call("DELETE", `/v1/agent/sinks/${sink.id}`, b.credential)).status).toBe(404);
    const tested = await call("POST", `/v1/agent/sinks/${sink.id}/test`, b.credential);
    expect(tested.status).toBe(404);
    expect(await tested.json()).toEqual({ error: "not_found" });
    expect(posts).toBe(0);
    expect(await (await call("GET", `/v1/agent/sinks?repo=${a.fullName}`, b.credential)).json()).toEqual({ sinks: [] });
  });

  it("answers 429 with Retry-After on the 31st write of the hour", async () => {
    for (let i = 0; i < QUOTAS.sinkConfigWritesPerHour; i++) {
      const res = i % 2 === 0 ? await addHook(a, `https://hooks.example.com/${i}`) : await call("DELETE", `/v1/agent/sinks/snk_${i}`, a.credential);
      expect(res.status).toBe(i % 2 === 0 && i < 20 ? 201 : i % 2 === 0 ? 400 : 404);
    }
    const res = await addHook(a);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "quota_exceeded" });
    expect(res.headers.get("Retry-After")).toBe("3599");
    expect((await addHook(b)).status).toBe(201);
  });
});
