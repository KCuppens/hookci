import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { agentCredentialHash, markAgentOffline, revokeAgent, touchAgent } from "../src/db/agents";
import { markSuspended, setInstallationPermissions, upsertInstallation } from "../src/db/installations";
import { tenantDb } from "../src/db/tenant";
import { issueSession } from "../src/oauth/state";
import { QUOTAS } from "../src/quotas";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { seedTenant, type Tenant } from "./helpers/tenants";
import { withoutThemeScript } from "./helpers/theme";
import { seedRun } from "./logs/helpers";

const ORIGIN = "https://hub.test";
const ACME = 42;
const UMBRELLA = 43;
const BARE = 44;
const TABS = ["agents", "repositories", "settings"] as const;
const D = S.dashboard;

let acme: Tenant;
let umbrella: Tenant;

beforeEach(async () => {
  await clearTables();
  acme = await seedTenant(env, { installationId: ACME, teamId: "T0ACME" });
  umbrella = await seedTenant(env, { installationId: UMBRELLA, teamId: "T0UMBRELLA" });
});

/** A session cookie, as a Cookie header value, covering installationIds. */
async function sessionFor(installationIds: number[]): Promise<string> {
  const setCookie = await issueSession(env, { installationIds, githubUserId: 7001, githubLogin: "octocat" }, testClock.now());
  return setCookie.split(";")[0] ?? "";
}

function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7" };
  if (cookie !== undefined) headers.cookie = cookie;
  return exports.default.fetch(`${ORIGIN}${path}`, { headers, redirect: "manual" });
}

async function page(path: string, ids = [ACME]): Promise<string> {
  const res = await get(path, await sessionFor(ids));
  expect(res.status).toBe(200);
  return res.text();
}

async function bareInstallation(): Promise<void> {
  await upsertInstallation(env.DB, { id: BARE, account_login: "bare", account_type: "User", account_id: 440, created_at: Date.UTC(2026, 0, 15) });
}

describe("the tab pages", () => {
  it("answer 404 without a session, with an invalid id, and for an installation the session does not cover", async () => {
    const own = await sessionFor([ACME]);
    for (const tab of TABS) {
      for (const res of [await get(`/${ACME}/${tab}`), await get(`/${UMBRELLA}/${tab}`, own), await get(`/0/${tab}`, own), await get(`/abc/${tab}`, own)]) {
        expect(res.status).toBe(404);
        expect(await res.text()).toContain(D.notFoundTitle);
      }
    }
  });

  it("answer 404 for an installation that was deleted", async () => {
    await env.DB.prepare("UPDATE installations SET deleted_at = 5 WHERE id = ?1").bind(ACME).run();
    for (const tab of TABS) expect((await get(`/${ACME}/${tab}`, await sessionFor([ACME]))).status).toBe(404);
  });

  it("never show another installation's rows, even to a session that covers both", async () => {
    for (const tab of TABS) {
      const html = await page(`/${ACME}/${tab}`, [ACME, UMBRELLA]);
      for (const other of [umbrella.agentId, umbrella.fullName, `Team ${umbrella.teamId}`, umbrella.channelId]) expect(html).not.toContain(other);
    }
    expect(await page(`/${ACME}/agents`)).toContain(acme.agentId);
    expect(await page(`/${ACME}/repositories`)).toContain(acme.fullName);
    expect(await page(`/${ACME}/settings`)).toContain(`Team ${acme.teamId}`);
  });

  it("never render a credential, a token or a hash", async () => {
    await touchAgent(tenantDb(env.DB, ACME), acme.agentId, { protocolVersion: 1, agentVersion: "v0.3.0", lastSeenAt: testClock.now() });
    const secrets = [acme.credential, await agentCredentialHash(acme.credential), "credential_hash", "bot_token", `xoxb-${acme.teamId}`, acme.pairToken, "xoxb-"];
    for (const tab of TABS) {
      const html = await page(`/${ACME}/${tab}`);
      for (const secret of secrets) expect(html).not.toContain(secret);
    }
  });

  it("escape every stored value", async () => {
    await env.DB.prepare("UPDATE agents SET name = ?2, hostname = ?3 WHERE installation_id = ?1 AND agent_id = ?4").bind(ACME, "<b>evil</b>", "<i>h</i>", acme.agentId).run();
    await env.DB.prepare("UPDATE repos SET full_name = ?2, default_branch = ?3 WHERE installation_id = ?1").bind(ACME, "<u>x</u>/r", "<s>br</s>").run();
    await env.DB.prepare("UPDATE workspaces SET team_name = ?2 WHERE team_id = ?1").bind(acme.teamId, "<em>team</em>").run();
    await env.DB.prepare("UPDATE installations SET account_login = ?2 WHERE id = ?1").bind(ACME, "<p>acct</p>").run();
    await setInstallationPermissions(env.DB, ACME, { "<x>": "<y>" });
    const cookie = await sessionFor([ACME]);
    const seen: string[] = [];
    for (const tab of TABS) seen.push(await (await get(`/${ACME}/${tab}`, cookie)).text());
    const all = seen.join("");
    for (const raw of ["<b>evil</b>", "<i>h</i>", "<u>x</u>", "<s>br</s>", "<em>team</em>", "<p>acct</p>", "<x>", "<y>"]) expect(all).not.toContain(raw);
    for (const escaped of ["&lt;b&gt;evil&lt;/b&gt;", "&lt;i&gt;h&lt;/i&gt;", "&lt;u&gt;x&lt;/u&gt;/r", "&lt;s&gt;br&lt;/s&gt;", "&lt;em&gt;team&lt;/em&gt;", "&lt;p&gt;acct&lt;/p&gt;", "&lt;x&gt;: &lt;y&gt;"]) {
      expect(all).toContain(escaped);
    }
  });

  it("send the shared security headers and no script", async () => {
    for (const tab of TABS) {
      const res = await get(`/${ACME}/${tab}`, await sessionFor([ACME]));
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("cache-control")).toContain("no-store");
      const html = await res.text();
      if (tab === "repositories" || tab === "agents") expect(res.headers.get("content-security-policy")).toMatch(/script-src[^;]*'sha256-/);
      else expect(withoutThemeScript(html)).not.toMatch(/<script/i);
    }
  });

  it("mark their own tab as current in the header", async () => {
    for (const tab of TABS) {
      const html = await page(`/${ACME}/${tab}`);
      expect(html).toMatch(new RegExp(`aria-current="page"[^>]*>[^<]*(<[^>]+>)*[^<]*${{ agents: D.navAgents, repositories: D.navRepositories, settings: D.navSettings }[tab]}`));
    }
  });
});

describe("GET /:installationId/repositories", () => {
  const R = D.reposPage;

  it("lists each repository with its branch, agent, slack channel, last run and actions", async () => {
    await seedRun(ACME, acme.repoId, "run_newer", acme.agentId, "test", { state: "success", started_at: Date.UTC(2026, 4, 1) });
    await env.DB.prepare("UPDATE watches SET channel_name = 'deployments' WHERE installation_id = ?1").bind(ACME).run();
    const html = await page(`/${ACME}/repositories`);
    const row = html.match(/<tr>(?:(?!<\/tr>).)*<\/tr>/gs)?.find((r) => r.includes(acme.fullName)) ?? "";
    expect(row).toContain("main");
    expect(row).toContain(acme.agentId);
    expect(row).toContain("#deployments");
    expect(row).toContain(D.list.states.success);
    expect(row).toContain(`href="/${ACME}/runs/run_newer"`);
    expect(row).toContain(`href="https://github.com/${acme.fullName}"`);
    expect(row).toContain(`href="/${ACME}/runs?repo=${acme.repoId}"`);
    expect(row).toContain(`href="/${ACME}/repositories/bind?repo=${acme.repoId}"`);
    expect(html).toContain(`<b>${acme.fullName.split("/")[1]}</b>`);
    expect(html).toContain(R.unit(1));
  });

  it("shows a repository without an agent or runs, a broken watch and an offline agent", async () => {
    await env.DB.prepare("INSERT INTO repos (installation_id, repo_id, full_name, default_branch) VALUES (?1, 5, 'org42/idle', 'trunk')").bind(ACME).run();
    await env.DB.prepare("UPDATE watches SET status = 'broken', broken_reason = 'channel_not_found' WHERE installation_id = ?1").bind(ACME).run();
    await markAgentOffline(tenantDb(env.DB, ACME), acme.agentId, testClock.now() - 3_600_000);
    const html = await page(`/${ACME}/repositories`);
    const idle = html.match(/<tr>(?:(?!<\/tr>).)*<\/tr>/gs)?.find((r) => r.includes("org42/idle")) ?? "";
    expect(idle).toContain(R.noRuns);
    expect(idle).toContain("trunk");
    expect(idle).toContain(R.noAgent);
    expect(html).toContain(R.channelNotFound);
    expect(html).toContain(R.agentOffline);
  });

  it("searches by name and filters, server side", async () => {
    await env.DB.prepare("INSERT INTO repos (installation_id, repo_id, full_name, default_branch) VALUES (?1, 5, 'org42/idle', 'trunk')").bind(ACME).run();
    const found = await page(`/${ACME}/repositories?q=IDLE`);
    expect(found).toContain("org42/idle");
    expect(found).not.toContain(`>${acme.fullName}<`);
    const none = await page(`/${ACME}/repositories?q=nothing-matches`);
    expect(none).toContain(R.noMatches);
    const noAgent = await page(`/${ACME}/repositories?filter=noAgent`);
    expect(noAgent).toContain("org42/idle");
    expect(noAgent).not.toContain(`>${acme.fullName}<`);
  });

  it("shows the filter menu with the active filter as its label and marked current", async () => {
    const all = await page(`/${ACME}/repositories`);
    expect(all).toContain(`<summary class="ob">`);
    expect(all).toContain(R.filter);
    expect(all).toContain(`aria-current="true">${R.filters.all}</a>`);
    const filtered = await page(`/${ACME}/repositories?filter=noAgent`);
    expect(filtered).toMatch(new RegExp(`<summary class="ob">[^]*?${R.filters.noAgent}[^]*?</summary>`));
    expect(filtered).toContain(`aria-current="true">${R.filters.noAgent}</a>`);
  });

  it("escapes a search term and a repository name", async () => {
    await env.DB.prepare("INSERT INTO repos (installation_id, repo_id, full_name, default_branch) VALUES (?1, 6, 'org42/<img src=x>', 'main')").bind(ACME).run();
    const html = await page(`/${ACME}/repositories?q=${encodeURIComponent('"><script>alert(1)</script>')}`);
    expect(html).not.toContain("<script>alert(1)</script>");
    const all = await page(`/${ACME}/repositories`);
    expect(all).not.toContain("<img src=x>");
    expect(all).toContain("&lt;img src=x&gt;");
  });

  it("does not show another installation's runs of the same repo id", async () => {
    await seedRun(UMBRELLA, acme.repoId, "run_foreign", umbrella.agentId);
    const html = await page(`/${ACME}/repositories`);
    expect(html).not.toContain("run_foreign");
  });

  it("shows the empty state, without a table or a bind button, for an installation without repositories", async () => {
    await bareInstallation();
    const html = await page(`/${BARE}/repositories`, [BARE]);
    expect(html).toContain(R.empty.title);
    expect(html).not.toContain("<table");
    expect(html).not.toContain(R.bind);
  });
});

describe("GET /:installationId/settings", () => {
  it("shows the installation, its GitHub link, permissions, Slack workspaces, usage and limits", async () => {
    await setInstallationPermissions(env.DB, ACME, { metadata: "read", checks: "write" });
    const today = new Date(testClock.now()).toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO daily_counters (installation_id, day, runs) VALUES (?1, ?2, 7)").bind(ACME, today).run();
    const html = await page(`/${ACME}/settings`);
    expect(html).toContain("org42");
    expect(html).toContain(D.settingsPage.accountTypes.Organization);
    expect(html).toContain(`href="https://github.com/organizations/org42/settings/installations/${ACME}"`);
    expect(html).toContain("checks: write");
    expect(html).toContain("metadata: read");
    expect(html).toContain("1970-01-01");
    expect(html).toContain(D.settingsPage.active);
    expect(html).toContain(`Team ${acme.teamId}`);
    expect(html).toContain(D.settingsPage.slackStatus.active);
    expect(html).toContain(`href="/slack/install?installation_id=${ACME}"`);
    expect(html).toContain(D.settingsPage.ofLimit(7, QUOTAS.runsPerDay));
    expect(html).toContain(D.settingsPage.ofLimit(1, QUOTAS.agentsPerInstallation));
    expect(html).toContain(D.settingsPage.days(QUOTAS.retentionDays));
    expect(html).toContain(D.settingsPage.mib(10));
    expect(html).toContain(env.LATEST_AGENT_VERSION);
    expect(html).toContain("octocat");
  });

  it("counts only today's runs against the daily limit and only live agents against the agent limit", async () => {
    await env.DB.prepare("INSERT INTO daily_counters (installation_id, day, runs) VALUES (?1, '2020-02-02', 99)").bind(ACME).run();
    await revokeAgent(tenantDb(env.DB, ACME), acme.agentId, 5);
    const html = await page(`/${ACME}/settings`);
    expect(html).toContain(D.settingsPage.ofLimit(0, QUOTAS.runsPerDay));
    expect(html).toContain(D.settingsPage.ofLimit(0, QUOTAS.agentsPerInstallation));
  });

  it("links a personal account to its own GitHub settings", async () => {
    await bareInstallation();
    const html = await page(`/${BARE}/settings`, [BARE]);
    expect(html).toContain(`href="https://github.com/settings/installations/${BARE}"`);
    expect(html).toContain(D.settingsPage.accountTypes.User);
    expect(html).toContain("2026-01-15");
  });

  it("shows no Slack workspace, no permissions and a connect link for a bare installation", async () => {
    await bareInstallation();
    const html = await page(`/${BARE}/settings`, [BARE]);
    expect(html).toContain(D.settingsPage.slackNone);
    expect(html).toContain(`href="/slack/install?installation_id=${BARE}"`);
    expect(html).toContain(D.settingsPage.noPermissions);
  });

  it("shows a suspended installation and a revoked workspace", async () => {
    await markSuspended(env.DB, ACME, testClock.now() - 2 * 86_400_000);
    await env.DB.prepare("UPDATE workspaces SET status = 'revoked' WHERE team_id = ?1").bind(acme.teamId).run();
    const html = await page(`/${ACME}/settings`);
    expect(html).toContain(D.settingsPage.suspended(D.ago.days(2)));
    expect(html).toContain(D.settingsPage.slackStatus.revoked);
  });

  it("copes with permissions that are not a JSON object", async () => {
    for (const bad of ["not json", "[1,2]", "null", '{"a":1}']) {
      await env.DB.prepare("UPDATE installations SET permissions = ?2 WHERE id = ?1").bind(ACME, bad).run();
      expect(await page(`/${ACME}/settings`)).toContain(D.settingsPage.noPermissions);
    }
  });

  it("lists only the workspaces linked to this installation", async () => {
    await env.DB.prepare("INSERT INTO workspace_links (team_id, installation_id, linked_by, created_at) VALUES (?1, ?2, 'U1', 3)").bind(umbrella.teamId, ACME).run();
    const html = await page(`/${ACME}/settings`);
    expect(html).toContain(`Team ${acme.teamId}`);
    expect(html).toContain(`Team ${umbrella.teamId}`);
    const other = await page(`/${UMBRELLA}/settings`, [UMBRELLA]);
    expect(other).not.toContain(`Team ${acme.teamId}`);
  });
});
