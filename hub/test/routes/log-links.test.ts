import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueSession } from "../../src/auth/session";
import { stableLogLink } from "../../src/logs/links";
import { verifyLogUrl } from "../../src/logs/signing";
import { issueState } from "../../src/oauth/state";
import { renderTelegram } from "../../src/sinks/telegram";
import type { JobView, RunView } from "../../src/sinks/types";
import { buildWebhookPayload } from "../../src/sinks/webhook";
import { renderBadge } from "../../src/slack/badge";
import { renderAlert, renderRunMessage } from "../../src/slack/messages";
import { testClock } from "../clock";
import { type CommandWorld, INSTALLATION, LOGIN, permissionCalls, REPO, setUpCommandWorld } from "../commands-helpers";
import { seedRun } from "../logs/helpers";

const RUN = "run_links_1";
const USER_TOKEN = "ghu_logsUserToken0123456789";
const TOKEN_PATH = `/applications/${env.GITHUB_CLIENT_ID}/token`;
const sources: Record<string, string> = import.meta.glob<string>("../../src/**/*.ts", { query: "?raw", import: "default", eager: true });

let world: CommandWorld;
let visibility: "public" | "private";

beforeEach(async () => {
  world = await setUpCommandWorld();
  visibility = "private";
  world.gh.respond("GET", "/repositories/:id", ({ params }) =>
    Number(params.id) === REPO.repo_id
      ? Response.json({ id: REPO.repo_id, name: "api", full_name: REPO.full_name, private: visibility === "private", owner: { login: "acme" } })
      : Response.json({ message: "Not Found" }, { status: 404 }),
  );
  world.gh.respond("POST", "/login/oauth/access_token", () => Response.json({ access_token: USER_TOKEN, token_type: "bearer", scope: "" }));
  world.gh.respond("GET", "/user", ({ headers }) =>
    headers.get("authorization") === `Bearer ${USER_TOKEN}` ? Response.json({ id: 7001, login: LOGIN }) : Response.json({ message: "Bad credentials" }, { status: 401 }),
  );
  world.gh.respond("DELETE", TOKEN_PATH, () => new Response(null, { status: 204 }));
  await seedRun(INSTALLATION, REPO.repo_id, RUN, null);
});

afterEach(() => world.restore());

function get(url: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.9" };
  if (cookie !== undefined) headers.cookie = cookie;
  return exports.default.fetch(url, { headers, redirect: "manual" });
}

const callback = (state: string, code = "c0de") => `${env.HUB_ORIGIN}/auth/github/callback?code=${code}&state=${encodeURIComponent(state)}`;

/** The cookie a browser sends back for a Set-Cookie value. */
const cookieOf = (setCookie: string | undefined) => (setCookie ?? "").split(";")[0] ?? "";

function exchangeCalls(): number {
  return world.gh.calls.filter((c) => c.url === "https://github.com/login/oauth/access_token").length;
}

async function expectSignedViewer(res: Response): Promise<void> {
  expect(res.status).toBe(302);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const location = new URL(res.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(`${env.HUB_ORIGIN}/logs/view`);
  expect(await verifyLogUrl(env, location.searchParams, new Date(testClock.now()))).toEqual({
    ok: true,
    ref: { installationId: INSTALLATION, runId: RUN, job: "test" },
  });
}

describe("GET /runs/:runId/logs", () => {
  it("sends anyone to a fresh signed viewer URL for a public repo", async () => {
    visibility = "public";
    await expectSignedViewer(await get(stableLogLink(env, RUN, "test")));
    expect(permissionCalls(world)).toEqual([]);
    expect(await env.DB.prepare("SELECT kind FROM oauth_states").all()).toMatchObject({ results: [] });
  });

  it("sends a browser without a session on a private repo to GitHub sign-in", async () => {
    const res = await get(stableLogLink(env, RUN, "test"));
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(env.GITHUB_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${env.HUB_ORIGIN}/auth/github/callback`);
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-hookci_oauth=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
    expect(await env.DB.prepare("SELECT kind, payload FROM oauth_states").all()).toMatchObject({
      results: [{ kind: "github_logs", payload: JSON.stringify({ return_to: `/runs/${RUN}/logs?job=test` }) }],
    });
  });

  it("signs a collaborator in through the callback, then opens the private log", async () => {
    world.roles[LOGIN] = "read";
    const start = await get(stableLogLink(env, RUN, "test"));
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const done = await get(callback(state), cookieOf(start.headers.get("set-cookie") ?? undefined));
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(stableLogLink(env, RUN, "test"));
    const cookies = done.headers.getSetCookie();
    expect(cookies).toContain("__Host-hookci_oauth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
    const session = cookies.find((c) => c.startsWith("hci_session="));
    expect(session).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800$/);
    expect(world.gh.calls.filter((c) => c.method === "DELETE" && new URL(c.url).pathname === TOKEN_PATH)).toHaveLength(1);

    await expectSignedViewer(await get(stableLogLink(env, RUN, "test"), cookieOf(session)));
    expect(permissionCalls(world)).toHaveLength(1);
    expect((await get(callback(state), cookieOf(start.headers.get("set-cookie") ?? undefined))).status).toBe(400);
  });

  it("starts sign-in again for a tampered session", async () => {
    world.roles[LOGIN] = "read";
    const [name, value] = cookieOf(await issueSession(env, { githubUserId: 7001, login: LOGIN }, testClock.now())).split("=");
    const [version, payload, signature] = (value ?? "").split(".");
    const forged = `${name}=${version}.${payload}.${signature?.[0] === "A" ? "B" : "A"}${signature?.slice(1)}`;
    const res = await get(stableLogLink(env, RUN, "test"), forged);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    expect(permissionCalls(world)).toEqual([]);
  });

  it("answers a signed-in user without a role with the same 404 as an unknown run or job", async () => {
    const session = cookieOf(await issueSession(env, { githubUserId: 66, login: "mallory" }, testClock.now()));
    const denied = await get(stableLogLink(env, RUN, "test"), session);
    expect(denied.status).toBe(404);
    expect(denied.headers.get("location")).toBeNull();
    const body = await denied.text();
    expect(permissionCalls(world, "mallory")).toHaveLength(1);
    for (const url of [stableLogLink(env, "run_nope", "test"), stableLogLink(env, RUN, "lint"), `${env.HUB_ORIGIN}/runs/${RUN}/logs`, stableLogLink(env, RUN, "../x")]) {
      const res = await get(url, session);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(body);
    }
  });
});

describe("GET /auth/github/callback", () => {
  it("refuses a forged state, another flow's state and a state without its cookie with 400", async () => {
    const link = await issueState(env, "github_link", { team_id: "T0ACME", slack_user_id: "U0USER" }, testClock.now());
    const logs = await issueState(env, "github_logs", { return_to: `/runs/${RUN}/logs?job=test` }, testClock.now());
    for (const [state, cookie] of [
      ["forged.state", undefined],
      [link.state, cookieOf(link.cookie)],
      [logs.state, undefined],
      [logs.state, cookieOf(link.cookie)],
    ] as const) {
      const res = await get(callback(state), cookie);
      expect(res.status).toBe(400);
      expect(res.headers.getSetCookie().some((c) => c.startsWith("hci_session="))).toBe(false);
    }
    expect(exchangeCalls()).toBe(0);
  });

  it("refuses to return anywhere but a stable log link", async () => {
    for (const returnTo of ["https://evil.example/", "//evil.example/runs/x/logs?job=test", "/logs/view?i=1", `/runs/${RUN}/logs?job=test#x`]) {
      const issued = await issueState(env, "github_logs", { return_to: returnTo }, testClock.now());
      const res = await get(callback(issued.state), cookieOf(issued.cookie));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(exchangeCalls()).toBe(0);
  });
});

describe("persistent payloads", () => {
  const test: JobView = { name: "test", state: "failed", logLink: stableLogLink(env, RUN, "test"), tail: ["boom"] };
  const run: RunView = {
    installationId: INSTALLATION,
    repoId: REPO.repo_id,
    repo: REPO.full_name,
    triggerId: RUN,
    runId: RUN,
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    event: "push",
    target: "branch",
    state: "failed",
    commitTitle: "Fix the build",
    authorLogin: "octocat",
    jobs: [test],
  };

  it("carry the stable link, never a signed viewer URL", () => {
    const payloads = [
      renderRunMessage(run, { notify: "normal" }),
      renderAlert(run, test, ["boom"], null, test.logLink ?? null),
      renderBadge(run),
      buildWebhookPayload(run, "01X", new Date(testClock.now())),
      renderTelegram(run).text,
    ];
    for (const payload of payloads) {
      const text = JSON.stringify(payload);
      expect(text).toContain(stableLogLink(env, RUN, "test"));
      expect(text).not.toContain("/logs/view?");
    }
    expect(buildWebhookPayload(run, "01X", new Date(testClock.now())).run.log_url).toBe(stableLogLink(env, RUN, "test"));
  });

  it("only the browser route and the Slack button mint signed viewer URLs", () => {
    const minters = Object.entries(sources)
      .filter(([, source]) => /\bsignLogUrl\(/.test(source))
      .map(([path]) => path.replace("../../src/", ""))
      .sort();
    expect(minters).toEqual(["logs/signing.ts", "routes/log-links.ts", "slack/view-logs.ts"]);
  });
});
