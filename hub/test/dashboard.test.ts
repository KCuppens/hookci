import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setJobLog } from "../src/db/runs";
import { tenantDb } from "../src/db/tenant";
import type { Installation } from "../src/github/types";
import { logKey } from "../src/logs/keys";
import { issueSession } from "../src/oauth/state";
import { escapeHtml } from "../src/pages/layout";
import { QUOTAS } from "../src/quotas";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { createFakeGitHub, serveInstallationTokens } from "./fakes/github";
import type { FakeService } from "./fakes/http";
import { generateAppKey } from "./github/helpers";
import { seedTenant, type Tenant } from "./helpers/tenants";
import { gzip, numberedLines, seedRun } from "./logs/helpers";

async function serveGitHubApp(): Promise<void> {
  serveInstallationTokens(gh, testClock.now());
  const saved = env.GITHUB_APP_PRIVATE_KEY;
  env.GITHUB_APP_PRIVATE_KEY = (await generateAppKey()).pem;
  restore.push(() => {
    env.GITHUB_APP_PRIVATE_KEY = saved;
  });
}

const ORIGIN = "https://hub.test";
const USER_TOKEN = "ghu_dashboardUserToken0123456789";
const GITHUB_USER = { id: 7001, login: "octocat" };
const APP_ID = Number(env.GITHUB_APP_ID);
const ACME = 42;
const UMBRELLA = 43;
const STRANGER = 99;

let acme: Tenant;
let umbrella: Tenant;
let gh: FakeService;
let userInstallations: Installation[];
const restore: (() => void)[] = [];

function installation(id: number, login: string): Installation {
  return {
    id,
    app_id: APP_ID,
    account: { id: id * 10, login, type: "Organization" },
    target_id: id * 10,
    target_type: "Organization",
    permissions: { contents: "read", metadata: "read", checks: "write" },
    suspended_at: null,
  };
}

beforeEach(async () => {
  await clearTables();
  acme = await seedTenant(env, { installationId: ACME, teamId: "T0ACME" });
  umbrella = await seedTenant(env, { installationId: UMBRELLA, teamId: "T0UMBRELLA" });
  gh = createFakeGitHub();
  userInstallations = [installation(ACME, "org42")];
  gh.respond("POST", "/login/oauth/access_token", () => Response.json({ access_token: USER_TOKEN, token_type: "bearer", scope: "" }));
  gh.respond("GET", "/user/installations", ({ headers }) =>
    headers.get("authorization") === `Bearer ${USER_TOKEN}`
      ? Response.json({ total_count: userInstallations.length, installations: userInstallations })
      : Response.json({ message: "Bad credentials" }, { status: 401 }),
  );
  gh.respond("GET", "/user", () => Response.json(GITHUB_USER));
  const saved = env.__TEST_FETCHER;
  env.__TEST_FETCHER = gh.fetcher;
  restore.push(() => {
    env.__TEST_FETCHER = saved;
  });
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  vi.restoreAllMocks();
});

/** A session cookie, as a Cookie header value, covering installationIds. */
async function sessionFor(installationIds: number[], now = testClock.now()): Promise<string> {
  const setCookie = await issueSession(env, { installationIds, githubUserId: GITHUB_USER.id, githubLogin: GITHUB_USER.login }, now);
  return setCookie.split(";")[0] ?? "";
}

function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7" };
  if (cookie !== undefined) headers.cookie = cookie;
  return exports.default.fetch(`${ORIGIN}${path}`, { headers, redirect: "manual" });
}

async function rows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...params).all<T>()).results;
}

/** The run ids a page links to, in order, once each (a row links its run from the pill and from the menu). */
function runLinks(html: string): string[] {
  const ids = [...html.matchAll(/href="\/app\/\d+\/runs\/([^"/?]+)"/g)].map((m) => m[1] ?? "");
  return ids.filter((id, i) => ids.indexOf(id) === i);
}

describe("GET /app", () => {
  it("shows a sign-in page with a button to /app/login when there is no session", async () => {
    const res = await get("/app");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("unsafe");
    const html = await res.text();
    expect(html).toContain(escapeHtml(S.dashboard.signInTitle));
    expect(html).toContain('href="/app/login"');
    expect(html).not.toContain("<script");
  });

  it("shows the sign-in page for an expired session", async () => {
    const stale = await sessionFor([ACME], testClock.now() - 31 * 60_000);
    const res = await get("/app", stale);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/app/login"');
  });

  it("redirects a session to its first installation", async () => {
    const res = await get("/app", await sessionFor([UMBRELLA, ACME]));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/app/${UMBRELLA}`);
  });

  it("skips session installations that are no longer installed", async () => {
    await env.DB.prepare("UPDATE installations SET deleted_at = 1 WHERE id = ?1").bind(UMBRELLA).run();
    const res = await get("/app", await sessionFor([UMBRELLA, ACME]));
    expect(res.headers.get("location")).toBe(`/app/${ACME}`);
  });
});

describe("GET /app/login and the OAuth callback", () => {
  async function beginLogin(): Promise<{ state: string; cookie: string }> {
    const res = await get("/app/login");
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe(`${env.HUB_ORIGIN}/github/oauth/callback`);
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toEqual([expect.stringMatching(/^__Host-hookci_oauth=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/)]);
    return { state: location.searchParams.get("state") ?? "", cookie: (setCookie[0] ?? "").split(";")[0] ?? "" };
  }

  function callback(state: string, cookie: string): Promise<Response> {
    return get(`/github/oauth/callback?${new URLSearchParams({ code: "oauth-code", state })}`, cookie);
  }

  it("starts the GitHub flow under a dashboard_login state", async () => {
    await beginLogin();
    expect(await rows("SELECT kind FROM oauth_states")).toEqual([{ kind: "dashboard_login" }]);
  });

  it("issues a session for the installations the user can access and redirects to /app", async () => {
    userInstallations = [installation(ACME, "org42"), installation(UMBRELLA, "org43"), installation(STRANGER, "stranger")];
    const { state, cookie } = await beginLogin();
    const res = await callback(state, cookie);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/app");
    const setCookie = res.headers.getSetCookie();
    const session = setCookie.find((c) => c.startsWith("__Host-hookci_session="));
    expect(session).toMatch(/Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800$/);
    expect(setCookie.some((c) => c.startsWith("__Host-hookci_oauth=") && c.includes("Max-Age=0"))).toBe(true);

    const sessionCookie = (session ?? "").split(";")[0] ?? "";
    expect((await get(`/app/${ACME}`, sessionCookie)).status).toBe(200);
    expect((await get(`/app/${UMBRELLA}`, sessionCookie)).status).toBe(200);
    // Not installed on the hub, so the session does not cover it.
    expect((await get(`/app/${STRANGER}`, sessionCookie)).status).toBe(404);
    // Read-only: signing in synced nothing from GitHub.
    expect(await rows("SELECT id FROM installations WHERE id = ?1", STRANGER)).toEqual([]);
  });

  it("does not cover installations the user cannot access", async () => {
    const { state, cookie } = await beginLogin();
    const res = await callback(state, cookie);
    const sessionCookie = (res.headers.getSetCookie().find((c) => c.startsWith("__Host-hookci_session=")) ?? "").split(";")[0] ?? "";
    expect((await get(`/app/${ACME}`, sessionCookie)).status).toBe(200);
    expect((await get(`/app/${UMBRELLA}`, sessionCookie)).status).toBe(404);
  });

  it("tells a user with no hub installation to install the GitHub App, and sets no session", async () => {
    userInstallations = [installation(STRANGER, "stranger")];
    const { state, cookie } = await beginLogin();
    const res = await callback(state, cookie);

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-hookci_session="))).toBe(false);
    const html = await res.text();
    expect(html).toContain(escapeHtml(S.dashboard.noInstallationTitle));
    expect(html).toContain('href="/start"');
  });

  it("consumes the state: a replayed callback is refused", async () => {
    const { state, cookie } = await beginLogin();
    expect((await callback(state, cookie)).status).toBe(303);
    const replay = await callback(state, cookie);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain(S.errorPage.codes.oauth_state_invalid.title);
  });

  it("refuses a callback whose browser cookie does not belong to the state", async () => {
    const { state } = await beginLogin();
    const other = await beginLogin();
    const res = await callback(state, other.cookie);
    expect(res.status).toBe(400);
  });
});

describe("GET /app/:installationId", () => {
  it("shows the account, its runs and its agents to a session that covers it", async () => {
    await env.DB.prepare("UPDATE runs SET started_at = ?1 WHERE run_id = ?2").bind(Date.now(), acme.runId).run();
    const res = await get(`/app/${ACME}`, await sessionFor([ACME]));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain("org42");
    expect(html).toContain(acme.fullName);
    expect(html).toContain(">main<");
    expect(html).toContain(acme.headSha.slice(0, 7));
    expect(html).toContain(acme.agentId);
    expect(html).toContain("0.1.0");
    expect(html).toContain(`href="/app/${ACME}/runs/${acme.runId}"`);
    expect(html).not.toContain(umbrella.fullName);
    expect(html).not.toContain("<script>alert");
  });

  it("answers 404 for an installation the session does not cover, and for one that does not exist", async () => {
    const cookie = await sessionFor([ACME]);
    for (const id of [UMBRELLA, 12345, "abc", "0", "-1", "042x"]) {
      const res = await get(`/app/${id}`, cookie);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain(escapeHtml(S.dashboard.notFoundTitle));
      expect(html).not.toContain(umbrella.fullName);
    }
  });

  it("answers 404 without a session or with a forged one", async () => {
    expect((await get(`/app/${ACME}`)).status).toBe(404);
    const forged = `${(await sessionFor([ACME])).slice(0, -3)}abc`;
    expect((await get(`/app/${ACME}`, forged)).status).toBe(404);
  });

  it("answers 404 once the installation is deleted", async () => {
    const cookie = await sessionFor([ACME]);
    await env.DB.prepare("UPDATE installations SET deleted_at = 1 WHERE id = ?1").bind(ACME).run();
    expect((await get(`/app/${ACME}`, cookie)).status).toBe(404);
  });

  it("pages runs 50 at a time, newest first, with numbered pages", async () => {
    expect(QUOTAS.dashboardRunsPerPage).toBe(50);
    for (let i = 1; i <= 55; i++) await seedRun(ACME, acme.repoId, `p_${i}`, acme.agentId, "test", { started_at: 100 + i });
    const cookie = await sessionFor([ACME]);

    const first = await (await get(`/app/${ACME}/runs`, cookie)).text();
    const firstIds = runLinks(first);
    expect(firstIds).toHaveLength(50);
    expect(firstIds[0]).toBe("p_55");
    expect(firstIds).not.toContain(acme.runId);
    expect(first).toContain(escapeHtml(S.dashboard.list.showing(50)));
    expect(first).toContain(`href="/app/${ACME}/runs?page=2"`);
    expect(first).toContain(`aria-label="${S.dashboard.list.nextPage}"`);

    const second = await (await get(`/app/${ACME}/runs?page=2`, cookie)).text();
    const secondIds = runLinks(second);
    expect(secondIds).toEqual(["p_5", "p_4", "p_3", "p_2", "p_1", acme.runId]);
    expect(second).toContain(escapeHtml(S.dashboard.list.showing(6)));
    expect(second).toContain('aria-current="page"');
    expect(second).not.toContain(`href="/app/${ACME}/runs?page=3"`);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(56);
  });

  it("keeps the filters in the page links and sorts oldest first on request", async () => {
    for (let i = 1; i <= 55; i++) await seedRun(ACME, acme.repoId, `s_${i}`, acme.agentId, "test", { state: "success", started_at: 100 + i });
    const cookie = await sessionFor([ACME]);
    const html = await (await get(`/app/${ACME}/runs?state=success&sort=oldest`, cookie)).text();
    expect(runLinks(html)[0]).toBe("s_1");
    expect(html).toContain(`href="/app/${ACME}/runs?state=success&amp;sort=oldest&amp;page=2"`);
  });

  it("shows page one for a malformed or non-positive page number", async () => {
    const cookie = await sessionFor([ACME]);
    for (const page of ["abc", "0", "-1", "9999999999999999999999"]) {
      const res = await get(`/app/${ACME}/runs?page=${page}`, cookie);
      expect(res.status).toBe(200);
      expect(runLinks(await res.text())).toEqual([acme.runId]);
    }
  });

  it("writes a run's duration as minutes and zero-padded seconds", async () => {
    await seedRun(ACME, acme.repoId, "run_long", acme.agentId, "test", { state: "success", started_at: 5000, finished_at: 133_000, duration_ms: 128_000 });
    const html = await (await get(`/app/${ACME}/runs?state=success`, await sessionFor([ACME]))).text();
    expect(html).toContain("2m 08s");
  });

  it("lets the page load GitHub avatars and nothing else, with no inline script", async () => {
    const res = await get(`/app/${ACME}/runs`, await sessionFor([ACME]));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("img-src https://github.com https://avatars.githubusercontent.com;");
    expect(csp).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain(`src="https://github.com/${acme.githubLogin}.png?size=56"`);
    expect(html).not.toMatch(/\sstyle="/);
  });

  it("tells the live banner how many runs arrived after the newest it has seen", async () => {
    const cookie = await sessionFor([ACME]);
    const html = await (await get(`/app/${ACME}/runs`, cookie)).text();
    const after = /data-after="(\d+)"/.exec(html)?.[1] ?? "";
    expect(after).not.toBe("");
    expect(html).toContain(`data-newer="/app/${ACME}/runs/newer"`);
    await seedRun(ACME, acme.repoId, "run_new_a", acme.agentId, "test", { state: "success" });
    await seedRun(ACME, acme.repoId, "run_new_b", acme.agentId, "test", { state: "failed" });
    const all = await get(`/app/${ACME}/runs/newer?after=${after}`, cookie);
    expect(all.status).toBe(200);
    expect(all.headers.get("cache-control")).toBe("no-store");
    expect(await all.json()).toMatchObject({ count: 2 });
    const some = await get(`/app/${ACME}/runs/newer?after=${after}&state=success`, cookie);
    expect(await some.json()).toMatchObject({ count: 1 });
  });

  it("answers the live banner with 400 for a malformed cursor and 404 without cover", async () => {
    const cookie = await sessionFor([ACME]);
    expect((await get(`/app/${ACME}/runs/newer?after=abc`, cookie)).status).toBe(400);
    expect((await get(`/app/${ACME}/runs/newer`, cookie)).status).toBe(400);
    expect((await get(`/app/${ACME}/runs/newer?after=0`)).status).toBe(404);
    expect((await get(`/app/${UMBRELLA}/runs/newer?after=0`, cookie)).status).toBe(404);
  });

  it("lists the other covered accounts and omits revoked agents", async () => {
    await env.DB.prepare("UPDATE agents SET status = 'revoked' WHERE installation_id = ?1").bind(ACME).run();
    const html = await (await get(`/app/${ACME}`, await sessionFor([ACME, UMBRELLA]))).text();
    expect(html).toContain(`href="/app/${UMBRELLA}"`);
    expect(html).toContain(escapeHtml(S.dashboard.noAgents));
    expect(html).not.toContain("0.1.0");
  });

  it("escapes a hostile branch name, repo-controlled text and the account login", async () => {
    const hostile = `refs/heads/<script>alert(1)</script>"'&<img src=x onerror=y>`;
    await seedRun(ACME, acme.repoId, "run_hostile", acme.agentId, "test", { ref: hostile, commit_title: "<b>title</b>", author_login: "<i>a</i>" });
    await env.DB.prepare("UPDATE runs SET started_at = ?1 WHERE run_id = ?2").bind(Date.now(), "run_hostile").run();
    const cookie = await sessionFor([ACME]);
    for (const path of [`/app/${ACME}`, `/app/${ACME}/runs/run_hostile`]) {
      const html = await (await get(path, cookie)).text();
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain("<b>title");
    }
  });

  it("escapes hostile run text in the runs list and in its filter options", async () => {
    const hostile = `refs/heads/<script>alert(1)</script>"'&<img src=x onerror=y>`;
    await seedRun(ACME, acme.repoId, "run_hostile", acme.agentId, "test", { ref: hostile, commit_title: "<b>title</b>", author_login: "a<i>b" });
    const html = await (await get(`/app/${ACME}/runs`, await sessionFor([ACME]))).text();
    expect(runLinks(html)).toContain("run_hostile");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>title");
    expect(html).not.toContain("a<i>b");
  });
});

describe("GET /app/:installationId overview", () => {
  it("counts only this installation's runs and flags gated runs", async () => {
    const now = testClock.now();
    await seedRun(ACME, acme.repoId, "run_ok", acme.agentId, "test", { state: "success", finished_at: now - 1000, duration_ms: 4000 });
    await seedRun(ACME, acme.repoId, "run_gate", acme.agentId, "test", { state: "gated", finished_at: null, duration_ms: null });
    await seedRun(UMBRELLA, umbrella.repoId, "run_other", umbrella.agentId, "test", { state: "gated", finished_at: null, duration_ms: null });
    const html = await (await get(`/app/${ACME}`, await sessionFor([ACME]))).text();
    expect(html).toContain(escapeHtml(S.dashboard.overview.gated(1)));
    expect(html).toContain(escapeHtml(S.dashboard.overview.title));
    expect(html).not.toContain(umbrella.fullName);
  });

  it("shows the all-clear when nothing needs attention", async () => {
    await env.DB.prepare("DELETE FROM runs WHERE installation_id = ?1").bind(ACME).run();
    await env.DB.prepare("DELETE FROM agents WHERE installation_id = ?1").bind(ACME).run();
    const html = await (await get(`/app/${ACME}`, await sessionFor([ACME]))).text();
    expect(html).toContain(escapeHtml(S.dashboard.overview.allClear));
    expect(html).toContain(escapeHtml(S.dashboard.overview.noFinishedRuns));
  });

  it("shows runs today against the real daily quota and labels the running jobs column", async () => {
    const day = new Date(testClock.now()).toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO daily_counters (installation_id, day, runs) VALUES (?1, ?2, 7)").bind(ACME, day).run();
    const html = await (await get(`/app/${ACME}`, await sessionFor([ACME]))).text();
    expect(html).toContain(`<span>7</span> <small>/ ${QUOTAS.runsPerDay}</small>`);
    expect(html).toContain(escapeHtml(S.dashboard.overview.remaining(QUOTAS.runsPerDay - 7)));
    expect(html).toContain(escapeHtml(S.dashboard.overview.runningJobs));
  });

  it("escapes a hostile agent name and keeps another installation's overview unreachable", async () => {
    await env.DB.prepare("UPDATE agents SET name = ?2 WHERE installation_id = ?1").bind(ACME, "<b>evil</b>").run();
    const cookie = await sessionFor([ACME]);
    const html = await (await get(`/app/${ACME}`, cookie)).text();
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(html).not.toContain("<b>evil");
    const other = await get(`/app/${UMBRELLA}`, cookie);
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain(umbrella.fullName);
  });
});

describe("GET /app/:installationId/runs filters", () => {
  it("filters by state and echoes the selection", async () => {
    await seedRun(ACME, acme.repoId, "run_pass", acme.agentId, "test", { state: "success" });
    const html = await (await get(`/app/${ACME}/runs?state=success`, await sessionFor([ACME]))).text();
    expect(runLinks(html)).toEqual(["run_pass"]);
    expect(html).toContain('<option value="success" selected>');
  });

  it("filters by branch and by commit prefix", async () => {
    await seedRun(ACME, acme.repoId, "run_dev", acme.agentId, "test", { ref: "refs/heads/dev", sha: "abcdef1234" });
    const cookie = await sessionFor([ACME]);
    expect(runLinks(await (await get(`/app/${ACME}/runs?branch=dev`, cookie)).text())).toEqual(["run_dev"]);
    expect(runLinks(await (await get(`/app/${ACME}/runs?sha=abcd`, cookie)).text())).toEqual(["run_dev"]);
  });

  it("drops unknown states and malformed values instead of failing", async () => {
    const res = await get(`/app/${ACME}/runs?state=bogus&repo=x&sha=%25%27`, await sessionFor([ACME]));
    expect(res.status).toBe(200);
    expect(runLinks(await res.text())).toEqual([acme.runId]);
  });

  it("never lists another installation's runs, even by repo id", async () => {
    const html = await (await get(`/app/${ACME}/runs?repo=${umbrella.repoId}`, await sessionFor([ACME]))).text();
    expect(runLinks(html)).toEqual([]);
    expect(html).not.toContain(umbrella.fullName);
  });
});

describe("GET /app/:installationId/runs/:runId", () => {
  it("shows the run and its jobs, with a log link once the log is stored", async () => {
    const html = await (await get(`/app/${ACME}/runs/${acme.runId}`, await sessionFor([ACME]))).text();
    expect(html).toContain(acme.fullName);
    expect(html).toContain("Fix the build");
    expect(html).toContain(`href="/app/${ACME}/runs/${acme.runId}/logs/${acme.job}/view"`);
    expect(html).not.toContain(escapeHtml(S.dashboard.logTruncated(QUOTAS.logBytes / 1_048_576)));
  });

  it("shows no log link for a job whose log is not uploaded yet", async () => {
    await seedRun(ACME, acme.repoId, "run_pending", acme.agentId, "build", { state: "running", finished_at: null, duration_ms: null });
    const html = await (await get(`/app/${ACME}/runs/run_pending`, await sessionFor([ACME]))).text();
    expect(html).toContain(escapeHtml(S.dashboard.noLogYet));
    expect(html).not.toContain("/logs/");
  });

  it("shows the truncated notice when the agent truncated the log", async () => {
    await setJobLog(tenantDb(env.DB, ACME), acme.runId, acme.job, { key: acme.logKey, bytes: 10, truncated: true });
    const html = await (await get(`/app/${ACME}/runs/${acme.runId}`, await sessionFor([ACME]))).text();
    expect(html).toContain(escapeHtml(S.dashboard.logTruncated(QUOTAS.logBytes / 1_048_576)));
  });

  it("offers retry with a CSRF field on a finished run, and the notice text", async () => {
    const html = await (await get(`/app/${ACME}/runs/${acme.runId}?notice=retried`, await sessionFor([ACME]))).text();
    expect(html).toContain(`action="/app/${ACME}/runs/${acme.runId}/retry"`);
    expect(html).toMatch(/name="csrf" value="[^"]+"/);
    expect(html).not.toContain(`/runs/${acme.runId}/approve`);
  });

  it("lists the changed files GitHub reports for the commit, with the real total", async () => {
    await serveGitHubApp();
    const files = Array.from({ length: 14 }, (_, i) => ({ filename: `src/f${i}.ts`, additions: i + 1, deletions: 0 }));
    gh.respond("GET", `/repos/${acme.fullName}/commits/:sha`, () => Response.json({ commit: { author: { date: "2026-01-01T00:00:00Z" } }, files }));
    const html = await (await get(`/app/${ACME}/runs/${acme.runId}`, await sessionFor([ACME]))).text();
    expect(html).toContain("src/f0.ts");
    expect(html).toContain("src/f11.ts");
    expect(html).not.toContain("src/f12.ts");
    expect(html).toContain(">14<");
  });

  it("omits the changed files when GitHub fails", async () => {
    await serveGitHubApp();
    await seedRun(ACME, acme.repoId, "run_fail", acme.agentId, "test", { sha: "c0ffee0000000000000000000000000000000000" });
    gh.respond("GET", `/repos/${acme.fullName}/commits/:sha`, () => Response.json({ message: "boom" }, { status: 500 }));
    const res = await get(`/app/${ACME}/runs/run_fail`, await sessionFor([ACME]));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(escapeHtml(S.dashboard.detail.changedFiles));
  }, 20_000);

  describe("commit changes", () => {
    const SHA = "c0ffee0000000000000000000000000000000001";
    const commitCalls = () => gh.calls.filter((c) => c.url.includes("/commits/"));
    const files = [{ filename: "src/cached.ts", additions: 1, deletions: 0 }];
    const commit = () => Response.json({ commit: { author: { date: "2026-01-01T00:00:00Z" } }, files });

    async function runPage(installationId: number, runId: string): Promise<string> {
      return (await get(`/app/${installationId}/runs/${runId}`, await sessionFor([installationId]))).text();
    }

    it("renders the page without the card when GitHub is slower than the timeout", async () => {
      await serveGitHubApp();
      await seedRun(ACME, acme.repoId, "run_slow", acme.agentId, "test", { sha: SHA.replace(/1$/, "2") });
      gh.respond("GET", `/repos/${acme.fullName}/commits/:sha`, () => new Promise<Response>(() => undefined));
      const started = Date.now();
      const res = await get(`/app/${ACME}/runs/run_slow`, await sessionFor([ACME]));
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(escapeHtml(S.dashboard.detail.changedFiles));
      expect(Date.now() - started).toBeLessThan(8000);
    }, 15_000);

    it("answers a second view from the cache without asking GitHub again", async () => {
      await serveGitHubApp();
      await seedRun(ACME, acme.repoId, "run_cached", acme.agentId, "test", { sha: SHA.replace(/1$/, "3") });
      gh.respond("GET", `/repos/${acme.fullName}/commits/:sha`, commit);
      expect(await runPage(ACME, "run_cached")).toContain("src/cached.ts");
      expect(await runPage(ACME, "run_cached")).toContain("src/cached.ts");
      expect(commitCalls()).toHaveLength(1);
    });

    it("does not report a commit GitHub no longer has", async () => {
      await serveGitHubApp();
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await seedRun(ACME, acme.repoId, "run_gone", acme.agentId, "test", { sha: SHA.replace(/1$/, "4") });
      for (const status of [404, 422]) {
        gh.respond("GET", `/repos/${acme.fullName}/commits/:sha`, () => Response.json({ message: "No commit found" }, { status }));
        const res = await get(`/app/${ACME}/runs/run_gone`, await sessionFor([ACME]));
        expect(res.status).toBe(200);
      }
      expect(errors).not.toHaveBeenCalled();
    });

    it("reports other GitHub failures", async () => {
      await serveGitHubApp();
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await seedRun(ACME, acme.repoId, "run_boom", acme.agentId, "test", { sha: SHA.replace(/1$/, "5") });
      gh.respond("GET", `/repos/${acme.fullName}/commits/:sha`, () => Response.json({ message: "boom" }, { status: 500 }));
      expect((await get(`/app/${ACME}/runs/run_boom`, await sessionFor([ACME]))).status).toBe(200);
      expect(errors).toHaveBeenCalled();
    }, 20_000);

    it("does not share one installation's cached answer with another", async () => {
      await serveGitHubApp();
      await seedRun(ACME, acme.repoId, "run_shared_a", acme.agentId, "test", { sha: SHA.replace(/1$/, "6") });
      await seedRun(UMBRELLA, umbrella.repoId, "run_shared_u", umbrella.agentId, "test", { sha: SHA.replace(/1$/, "6") });
      gh.respond("GET", /\/commits\//, commit);
      expect(await runPage(ACME, "run_shared_a")).toContain("src/cached.ts");
      expect(await runPage(UMBRELLA, "run_shared_u")).toContain("src/cached.ts");
      expect(commitCalls()).toHaveLength(2);
    });
  });

  it("answers 404 for another installation's run, under either installation", async () => {
    const cookie = await sessionFor([ACME]);
    expect((await get(`/app/${UMBRELLA}/runs/${umbrella.runId}`, cookie)).status).toBe(404);
    const res = await get(`/app/${ACME}/runs/${umbrella.runId}`, cookie);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(umbrella.fullName);
  });

  it("answers 404 for a run that does not exist or without a session", async () => {
    expect((await get(`/app/${ACME}/runs/nope`, await sessionFor([ACME]))).status).toBe(404);
    expect((await get(`/app/${ACME}/runs/${acme.runId}`)).status).toBe(404);
  });
});

describe("GET /app/:installationId/runs/:runId/logs/:job", () => {
  it("streams the log decompressed as inert text", async () => {
    const res = await get(`/app/${ACME}/runs/${acme.runId}/logs/${acme.job}`, await sessionFor([ACME]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(await res.text()).toBe("tenant 42 secret log\n");
  });

  it("streams a large log whole", async () => {
    const text = numberedLines(60_000);
    const key = logKey(ACME, "run_big", "build");
    await seedRun(ACME, acme.repoId, "run_big", acme.agentId, "build");
    await env.LOGS.put(key, await gzip(text));
    await setJobLog(tenantDb(env.DB, ACME), "run_big", "build", { key, bytes: text.length, truncated: false });
    const res = await get(`/app/${ACME}/runs/run_big/logs/build`, await sessionFor([ACME]));
    expect(await res.text()).toBe(text);
  });

  it("does not serve markup as HTML", async () => {
    const markup = "<script>alert(1)</script>\n";
    const key = logKey(ACME, "run_markup", "test");
    await seedRun(ACME, acme.repoId, "run_markup", acme.agentId);
    await env.LOGS.put(key, await gzip(markup));
    await setJobLog(tenantDb(env.DB, ACME), "run_markup", "test", { key, bytes: markup.length, truncated: false });
    const res = await get(`/app/${ACME}/runs/run_markup/logs/test`, await sessionFor([ACME]));
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(markup);
  });

  it("answers 404 for another installation's log, under either installation, and leaks nothing", async () => {
    const cookie = await sessionFor([ACME]);
    for (const path of [`/app/${UMBRELLA}/runs/${umbrella.runId}/logs/${umbrella.job}`, `/app/${ACME}/runs/${umbrella.runId}/logs/${umbrella.job}`]) {
      const res = await get(path, cookie);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).not.toContain("secret log");
    }
  });

  it("answers 404 without a session, for an unknown job, and for a job with no log yet", async () => {
    await seedRun(ACME, acme.repoId, "run_pending", acme.agentId, "build");
    const cookie = await sessionFor([ACME]);
    expect((await get(`/app/${ACME}/runs/${acme.runId}/logs/${acme.job}`)).status).toBe(404);
    expect((await get(`/app/${ACME}/runs/${acme.runId}/logs/nope`, cookie)).status).toBe(404);
    expect((await get(`/app/${ACME}/runs/run_pending/logs/build`, cookie)).status).toBe(404);
  });

  it("answers 404 when the stored object is gone", async () => {
    await env.LOGS.delete(acme.logKey);
    expect((await get(`/app/${ACME}/runs/${acme.runId}/logs/${acme.job}`, await sessionFor([ACME]))).status).toBe(404);
  });

  it("never reads an object outside the installation's prefix, even when the row points there", async () => {
    await setJobLog(tenantDb(env.DB, ACME), acme.runId, acme.job, { key: umbrella.logKey, bytes: 10, truncated: false });
    const res = await get(`/app/${ACME}/runs/${acme.runId}/logs/${acme.job}`, await sessionFor([ACME]));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("secret log");
  });
});
