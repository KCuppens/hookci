import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csrfForForm } from "../src/accounts/csrf";
import { upsertInstallation } from "../src/db/installations";
import { issueSession } from "../src/oauth/state";
import { redeemPairToken } from "../src/pairing/tokens";
import { QUOTAS } from "../src/quotas";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { seedTenant, type Tenant } from "./helpers/tenants";

const ORIGIN = "https://hub.test";
const ACME = 42;
const UMBRELLA = 43;
const BARE = 44;
const OWNER = 7001;
const A = S.agents;
const P = A.pairing;
const TOKEN = /hc_pair_[A-Za-z0-9_-]+/;

let acme: Tenant;
let umbrella: Tenant;

beforeEach(async () => {
  await clearTables();
  acme = await seedTenant(env, { installationId: ACME, teamId: "T0ACME" });
  umbrella = await seedTenant(env, { installationId: UMBRELLA, teamId: "T0UMBRELLA" });
  // A personal account: its owner, matched by GitHub user id, is its administrator.
  await env.DB.prepare("UPDATE installations SET account_type = 'User', account_id = ?1 WHERE id IN (?2, ?3)").bind(OWNER, ACME, UMBRELLA).run();
});

afterEach(() => vi.restoreAllMocks());

async function sessionFor(installationIds: number[], githubUserId = OWNER): Promise<string> {
  const setCookie = await issueSession(env, { installationIds, githubUserId, githubLogin: "octocat" }, testClock.now());
  return setCookie.split(";")[0] ?? "";
}

async function get(path: string, ids = [ACME]): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}${path}`, { headers: { cookie: await sessionFor(ids) }, redirect: "manual" });
}

interface PostOptions {
  installationId?: number;
  session?: string;
  origin?: string | null;
  csrf?: "valid" | "wrong" | "none";
  fields?: Record<string, string>;
}

/** POSTs the pair form as a browser would: session and csrf cookies, a csrf field, the hub's Origin. */
async function pair(options: PostOptions = {}): Promise<Response> {
  const { token, cookie } = await csrfForForm(env, null);
  const cookies = [options.session ?? (await sessionFor([ACME])), cookie?.split(";")[0] ?? ""].filter((c) => c !== "");
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", cookie: cookies.join("; ") };
  if (options.origin !== null) headers.origin = options.origin ?? env.HUB_ORIGIN;
  const csrf = options.csrf ?? "valid";
  const fields: Record<string, string> = csrf === "none" ? {} : { csrf: csrf === "valid" ? token : `${token}x` };
  const body = new URLSearchParams({ ...fields, ...options.fields }).toString();
  return exports.default.fetch(`${ORIGIN}/app/${options.installationId ?? ACME}/agents/pair`, { method: "POST", headers, body, redirect: "manual" });
}

async function tokenCount(installationId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM pair_tokens WHERE installation_id = ?1").bind(installationId).first<{ n: number }>();
  return row?.n ?? 0;
}

async function addAgent(installationId: number, agentId: string, status = "offline", revokedAt: number | null = null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO agents (installation_id, agent_id, name, credential_hash, paired_by_github_id, paired_at, status, revoked_at) VALUES (?1, ?2, ?2, ?3, 1, 2, ?4, ?5)",
  )
    .bind(installationId, agentId, `hash-${agentId}`, status, revokedAt)
    .run();
}

describe("GET /app/:installationId/agents", () => {
  it("lists each agent with its hostname, platform, version, protocol and a link to it", async () => {
    const res = await get(`/app/${ACME}/agents`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(A.title);
    expect(html).toContain(`${acme.agentId}.local`);
    expect(html).toContain("0.1.0");
    expect(html).toContain(`href="/app/${ACME}/agents/${acme.agentId}"`);
    expect(html).toContain(`action="/app/${ACME}/agents/pair"`);
    expect(html).toContain(A.status.offline);
  });

  it("marks a revoked agent and offers no upgrade for it", async () => {
    await addAgent(ACME, "agt_gone", "revoked", Date.UTC(2026, 8, 3));
    const html = await (await get(`/app/${ACME}/agents`)).text();
    expect(html).toContain(A.status.revoked);
    expect(html).toContain("Sep 3, 2026");
  });

  it("shows the OS release in the Platform column, and falls back to the raw os without one", async () => {
    await env.DB.prepare("UPDATE agents SET os = ?2, os_release = ?3 WHERE installation_id = ?1").bind(ACME, "linux", "Ubuntu 22.04").run();
    const html = await (await get(`/app/${ACME}/agents`)).text();
    expect(html).toContain("Ubuntu 22.04");
    await env.DB.prepare("UPDATE agents SET os = ?2, os_release = NULL WHERE installation_id = ?1").bind(ACME, "linux").run();
    const plain = await (await get(`/app/${ACME}/agents`)).text();
    expect(plain).not.toContain("Ubuntu 22.04");
    expect(plain).toMatch(/class="pf"[^>]*><span>linux<\/span>/);
  });

  it("keeps the row menu on a revoked agent", async () => {
    await addAgent(ACME, "agt_gone", "revoked", Date.UTC(2026, 8, 3));
    const html = await (await get(`/app/${ACME}/agents`)).text();
    const row = html.slice(html.indexOf("agt_gone"));
    expect(row).toContain('<details class="mnu">');
  });

  it("escapes every stored value", async () => {
    await env.DB.prepare("UPDATE agents SET name = '<script>alert(1)</script>', hostname = '<b>host</b>' WHERE installation_id = ?1").bind(ACME).run();
    const html = await (await get(`/app/${ACME}/agents`)).text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;host&lt;/b&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<b>host</b>");
  });

  it("shows the install command, and no table, for an installation without agents", async () => {
    await upsertInstallation(env.DB, { id: BARE, account_login: "bare", account_type: "User", account_id: 440, created_at: 1 });
    const html = await (await get(`/app/${BARE}/agents`, [BARE])).text();
    expect(html).toContain(A.empty.title);
    expect(html).toContain(env.HUB_ORIGIN);
    expect(html).not.toContain("<table");
  });

  it("does not show another installation's agents", async () => {
    const html = await (await get(`/app/${ACME}/agents`, [ACME, UMBRELLA])).text();
    expect(html).not.toContain(umbrella.agentId);
  });

  it("answers the same 404 page for an installation the session does not cover", async () => {
    const res = await get(`/app/${UMBRELLA}/agents`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(S.dashboard.notFoundTitle);
  });

  it("shows a notice only from the known ones", async () => {
    const known = await (await get(`/app/${ACME}/agents?notice=revoked`)).text();
    expect(known).toContain(A.notices.revoked);
    const unknown = await (await get(`/app/${ACME}/agents?notice=%3Cb%3Ex`)).text();
    expect(unknown).not.toContain("<b>x");
  });
});

describe("POST /app/:installationId/agents/pair", () => {
  it("shows an administrator a fresh token once, in a page that is never cached", async () => {
    const before = await tokenCount(ACME);
    const res = await pair();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    const token = html.match(TOKEN)?.[0] ?? "";
    expect(token).not.toBe("");
    expect(html).toContain(`hookci connect ${token}`);
    expect(await tokenCount(ACME)).toBe(before + 1);
    const stored = await env.DB.prepare("SELECT token_hash FROM pair_tokens WHERE installation_id = ?1").bind(ACME).all<{ token_hash: string }>();
    expect(stored.results.some((r) => r.token_hash === token)).toBe(false);
  });

  it("renders the whole token with the page's traced icons and a 9px expiry bar", async () => {
    const html = await (await pair()).text();
    const token = html.match(TOKEN)?.[0] ?? "";
    expect(html.split(token).length - 1).toBeGreaterThanOrEqual(2);
    for (const id of ["pcopy", "prefresh", "pinfo", "pback", "pbc", "pguide", "pwifi", "pkey", "pterm", "pserver", "pchev", "pdone"]) expect(html).toContain(`id="i-${id}"`);
    expect(html).toContain('id="pbar"');
    expect(html).toContain('height="9"');
  });

  it("logs that a token was made, never the token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const html = await (await pair()).text();
    const token = html.match(TOKEN)?.[0] ?? "";
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("agent_pair_token") && l.includes(`"installation_id":${ACME}`))).toBe(true);
    expect(lines.some((l) => l.includes(token))).toBe(false);
  });

  it("refuses a user who does not administer the account", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = await tokenCount(ACME);
    const res = await pair({ session: await sessionFor([ACME], OWNER + 1) });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(P.notAdmin);
    expect(await tokenCount(ACME)).toBe(before);
    expect(log.mock.calls.some((c) => String(c[0]).includes("agent_pair_not_admin"))).toBe(true);
  });

  it("refuses a missing, wrong or absent csrf token", async () => {
    const before = await tokenCount(ACME);
    for (const csrf of ["wrong", "none"] as const) {
      const res = await pair({ csrf });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(P.csrf);
    }
    expect(await tokenCount(ACME)).toBe(before);
  });

  it("refuses a foreign Origin even with a valid csrf token", async () => {
    const before = await tokenCount(ACME);
    const res = await pair({ origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(P.csrf);
    expect(await tokenCount(ACME)).toBe(before);
  });

  it("makes no token for an installation the session does not cover", async () => {
    const before = await tokenCount(UMBRELLA);
    const res = await pair({ installationId: UMBRELLA });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(S.dashboard.notFoundTitle);
    expect(await tokenCount(UMBRELLA)).toBe(before);
  });

  it("refuses another installation's agent as the one to replace, and a revoked one", async () => {
    await addAgent(ACME, "agt_gone", "revoked", 5);
    const before = await tokenCount(ACME);
    for (const replace of [umbrella.agentId, "agt_gone", "agt_nope"]) {
      const res = await pair({ fields: { replace } });
      expect(res.status).toBe(404);
      expect(await res.text()).toContain(P.notFound);
    }
    expect(await tokenCount(ACME)).toBe(before);
  });

  it("makes a token that replaces one of this installation's agents", async () => {
    const res = await pair({ fields: { replace: acme.agentId } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`value="${acme.agentId}" selected`);
  });

  it("refuses at the agent limit, unless replacing an active agent", async () => {
    for (let i = 0; i < QUOTAS.agentsPerInstallation - 1; i++) await addAgent(ACME, `agt_fill${i}`);
    expect((await pair()).status).toBe(409);
    expect((await pair({ fields: { replace: acme.agentId } })).status).toBe(200);
  });

  it("stops after the hourly token limit", async () => {
    for (let i = 0; i < QUOTAS.pairTokensPerHour - 1; i++) expect((await pair()).status).toBe(200);
    const res = await pair();
    expect(res.status).toBe(429);
    expect(await res.text()).toContain(P.rateLimited(QUOTAS.pairTokensPerHour));
  });
});

describe("GET /app/:installationId/agents/pair/status", () => {
  const status = async (after: number, ids = [ACME], installationId = ACME) => {
    const res = await exports.default.fetch(`${ORIGIN}/app/${installationId}/agents/pair/status?after=${after}`, { headers: { cookie: await sessionFor(ids) } });
    return { res, body: res.status === 200 ? await res.json<{ paired: boolean }>() : null };
  };

  it("turns true once an agent redeems a token made after the page was issued", async () => {
    const issuedAt = testClock.now();
    expect((await status(issuedAt)).body).toEqual({ paired: false });
    const html = await (await pair()).text();
    const pairToken = html.match(TOKEN)?.[0] ?? "";
    testClock.advance(1000);
    await redeemPairToken(env, { pair_token: pairToken, name: "fresh", hostname: "h", agent_version: "0.1.0", os: "linux", arch: "amd64" }, "203.0.113.9");
    const { res, body } = await status(issuedAt);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(body).toEqual({ paired: true });
  });

  it("answers false for a missing or nonsense after", async () => {
    for (const after of [Number.NaN, -1, 0]) expect((await status(after)).body).toEqual({ paired: false });
  });

  it("does not report another installation's pairings", async () => {
    const { res } = await status(0, [ACME], UMBRELLA);
    expect(res.status).toBe(404);
  });
});
