import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAnnotations } from "../src/db/annotations";
import { upsertJob } from "../src/db/runs";
import { tenantDb } from "../src/db/tenant";
import { issueSession } from "../src/oauth/state";
import { escapeHtml } from "../src/pages/layout";
import { S } from "../src/strings";
import { ulid, ulidTime } from "../src/ulid";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { createFakeGitHub } from "./fakes/github";
import { seedTenant, type Tenant } from "./helpers/tenants";
import { seedRun } from "./logs/helpers";

const ORIGIN = "https://hub.test";
const ACME = 42;
const UMBRELLA = 43;
const T = S.dashboard.detail;

let acme: Tenant;
let umbrella: Tenant;
const restore: (() => void)[] = [];

beforeEach(async () => {
  await clearTables();
  acme = await seedTenant(env, { installationId: ACME, teamId: "T0ACME" });
  umbrella = await seedTenant(env, { installationId: UMBRELLA, teamId: "T0UMBRELLA" });
  const saved = env.__TEST_FETCHER;
  env.__TEST_FETCHER = createFakeGitHub().fetcher;
  restore.push(() => {
    env.__TEST_FETCHER = saved;
  });
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

async function page(installationId: number, runId: string, sessionIds = [installationId]): Promise<Response> {
  const setCookie = await issueSession(env, { installationIds: sessionIds, githubUserId: 7001, githubLogin: "octocat" }, testClock.now());
  const cookie = setCookie.split(";")[0] ?? "";
  return exports.default.fetch(`${ORIGIN}/app/${installationId}/runs/${runId}`, { headers: { cookie, "cf-connecting-ip": "198.51.100.7" }, redirect: "manual" });
}

async function configJob(installationId: number, runId: string, state: string): Promise<void> {
  await upsertJob(tenantDb(env.DB, installationId), { run_id: runId, name: "_config", state, step: null, step_index: null, steps_total: null, duration_ms: 1 });
}

describe("ulidTime", () => {
  it("returns the millisecond a ULID was minted in", () => {
    expect(ulidTime(ulid(1_760_000_000_123))).toBe(1_760_000_000_123);
  });

  it("returns null for anything that is not one of our ULIDs", () => {
    expect(ulidTime("run_pending")).toBeNull();
    expect(ulidTime("")).toBeNull();
    expect(ulidTime(`${"u".repeat(26)}`)).toBeNull();
    expect(ulidTime(`${"z".repeat(26)}`)).toBeNull();
  });
});

describe("run page configuration card", () => {
  it("reports a valid .hookci.yml, counts the jobs without the config check, and links the file at the run's commit", async () => {
    await seedRun(ACME, acme.repoId, "run_cfg", acme.agentId, "build", { state: "success" });
    await configJob(ACME, "run_cfg", "success");
    const html = await (await page(ACME, "run_cfg")).text();
    expect(html).toContain(escapeHtml(T.configuration));
    expect(html).toContain(escapeHtml(S.checks.configValid));
    expect(html).toContain(escapeHtml(T.configJobs(1)));
    expect(html).toContain(escapeHtml(T.configValidated));
    expect(html).toContain(`href="${escapeHtml(T.configUrl(acme.fullName, "abcdef1234567890abcdef1234567890abcdef12"))}"`);
    expect(html).toContain(escapeHtml(T.jobsCount(1, 1)));
    expect(html).not.toContain("_config");
  });

  it("reports an invalid .hookci.yml when the config check failed", async () => {
    await seedRun(ACME, acme.repoId, "run_bad", acme.agentId, "build", { state: "skipped" });
    await configJob(ACME, "run_bad", "failed");
    const html = await (await page(ACME, "run_bad")).text();
    expect(html).toContain(escapeHtml(S.checks.configInvalid));
    expect(html).not.toContain(escapeHtml(S.checks.configValid));
    expect(html).not.toContain(escapeHtml(T.configValidated));
  });

  it("reports an invalid .hookci.yml when the agent rejected the run for it", async () => {
    await seedRun(ACME, acme.repoId, "run_rej", acme.agentId, "build", { state: "skipped", reason: "config_invalid" });
    const html = await (await page(ACME, "run_rej")).text();
    expect(html).toContain(escapeHtml(S.checks.configInvalid));
  });

  it("omits the card when the agent has not reported on the file", async () => {
    await seedRun(ACME, acme.repoId, "run_none", acme.agentId, "build", { state: "running", finished_at: null, duration_ms: null });
    const html = await (await page(ACME, "run_none")).text();
    expect(html).not.toContain(escapeHtml(T.configuration));
    expect(html).not.toContain(escapeHtml(S.checks.configValid));
    expect(html).not.toContain(escapeHtml(S.checks.configInvalid));
  });

  it("never shows another installation's run or its configuration", async () => {
    await configJob(UMBRELLA, umbrella.runId, "success");
    const res = await page(ACME, umbrella.runId);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(umbrella.fullName);
    expect(text).not.toContain(S.checks.configValid);
    expect((await page(UMBRELLA, umbrella.runId, [ACME])).status).toBe(404);
  });
});

async function setCreatedAt(installationId: number, runId: string, at: number): Promise<void> {
  await env.DB.prepare("UPDATE runs SET created_at = ?1 WHERE installation_id = ?2 AND run_id = ?3").bind(at, installationId, runId).run();
}

describe("run page timeline", () => {
  it("dates the creation of a run from its recorded creation time", async () => {
    await seedRun(ACME, acme.repoId, "run_time", acme.agentId, "build", { state: "gated", reason: "fork_gated", started_at: null, finished_at: null, duration_ms: null });
    await setCreatedAt(ACME, "run_time", testClock.now() - 2 * 60_000);
    const html = await (await page(ACME, "run_time")).text();
    const created = html.slice(html.indexOf(`<b>${T.created}</b>`));
    expect(created).toContain(escapeHtml(S.dashboard.ago.minutes(2)));
    const waiting = html.slice(html.indexOf(`<b>${T.waiting}</b>`));
    expect(waiting).toContain(escapeHtml(S.dashboard.ago.minutes(2)));
    expect(html).toContain(escapeHtml(T.createdMinutes(2)));
  });

  it("falls back to the trigger id's time when the run has no recorded creation time", async () => {
    await seedRun(ACME, acme.repoId, "run_fallback", acme.agentId, "build", {
      trigger_id: ulid(testClock.now() - 3 * 60_000),
      state: "gated",
      reason: "fork_gated",
      started_at: null,
      finished_at: null,
      duration_ms: null,
    });
    await setCreatedAt(ACME, "run_fallback", 0);
    const html = await (await page(ACME, "run_fallback")).text();
    expect(html).toContain(escapeHtml(T.createdMinutes(3)));
  });

  it("leaves the time out when neither the creation time nor the trigger id carries one", async () => {
    await seedRun(ACME, acme.repoId, "run_notime", acme.agentId, "build", { state: "gated", reason: "fork_gated", started_at: null, finished_at: null, duration_ms: null });
    await setCreatedAt(ACME, "run_notime", 0);
    const html = await (await page(ACME, "run_notime")).text();
    expect(html).toContain(`<b>${T.created}</b><span class="t"><i class="dash"`);
    expect(html).not.toContain(escapeHtml(T.createdAgo("")));
  });

  it("names the run by its number in the installation, not by its id", async () => {
    await seedRun(ACME, acme.repoId, "run_one", acme.agentId, "build");
    await seedRun(ACME, acme.repoId, "run_two", acme.agentId, "build");
    const row = await env.DB.prepare("SELECT run_number AS n FROM runs WHERE installation_id = ?1 AND run_id = ?2").bind(ACME, "run_two").first<{ n: number }>();
    const html = await (await page(ACME, "run_two")).text();
    expect(html).toContain(escapeHtml(T.run(String(row?.n))));
    expect(html).not.toContain(escapeHtml(T.run("run_two".slice(0, 8))));
  });
});

describe("run page annotations card", () => {
  const NOW = () => testClock.now();

  it("shows the empty state when the run has no annotations", async () => {
    await seedRun(ACME, acme.repoId, "run_empty", acme.agentId, "build");
    const html = await (await page(ACME, "run_empty")).text();
    expect(html).toContain(`<h2>${escapeHtml(T.annotations)}</h2><span class="cnt">0</span>`);
    expect(html).toContain(escapeHtml(T.annotationsEmptyTitle));
    expect(html).toContain(escapeHtml(T.annotationsEmptyBody));
  });

  it("lists the run's annotations with level, location, job and a link to the file at the run's commit", async () => {
    await seedRun(ACME, acme.repoId, "run_ann", acme.agentId, "lint");
    await insertAnnotations(
      tenantDb(env.DB, ACME),
      "run_ann",
      "lint",
      [
        { path: "src/a.ts", line: 12, level: "failure", message: "Unexpected any", title: "no-explicit-any" },
        { path: "src/b.ts", line: 3, level: "warning", message: "Unused variable" },
      ],
      NOW(),
    );
    const html = await (await page(ACME, "run_ann")).text();
    expect(html).toContain(`<span class="cnt">2</span>`);
    expect(html).toContain("Unexpected any");
    expect(html).toContain("<b>no-explicit-any</b>");
    expect(html).toContain("Unused variable");
    expect(html).toContain("src/a.ts:12");
    expect(html).toContain(escapeHtml(T.annotationUrl(acme.fullName, "abcdef1234567890abcdef1234567890abcdef12", "src/a.ts", 12)));
    expect(html).toContain(escapeHtml(T.levelOne["failure"] ?? ""));
    expect(html).not.toContain(escapeHtml(T.annotationsEmptyTitle));
  });

  it("escapes the message, title and path of an annotation", async () => {
    await seedRun(ACME, acme.repoId, "run_xss", acme.agentId, "lint");
    await insertAnnotations(
      tenantDb(env.DB, ACME),
      "run_xss",
      "lint",
      [{ path: "<img src=x onerror=alert(1)>.ts", line: 1, level: "notice", message: "<script>alert(1)</script>", title: "<b>bold</b>" }],
      NOW(),
    );
    const html = await (await page(ACME, "run_xss")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("never shows another installation's annotations", async () => {
    await seedRun(ACME, acme.repoId, "run_iso", acme.agentId, "lint");
    await insertAnnotations(tenantDb(env.DB, UMBRELLA), "run_iso", "lint", [{ path: "secret.ts", line: 9, level: "failure", message: "umbrella only finding" }], NOW());
    const html = await (await page(ACME, "run_iso")).text();
    expect(html).not.toContain("umbrella only finding");
    expect(html).not.toContain("secret.ts");
    expect(html).toContain(escapeHtml(T.annotationsEmptyTitle));
  });
});
