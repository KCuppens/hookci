import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markJobLogsLocal, setJobLog, upsertJob } from "../src/db/runs";
import { tenantDb } from "../src/db/tenant";
import type { Installation } from "../src/github/types";
import { logKey } from "../src/logs/keys";
import { readLogHead, renderLines, VIEW_BYTES } from "../src/logs/render";
import { issueSession } from "../src/oauth/state";
import { escapeHtml } from "../src/pages/layout";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { createFakeGitHub } from "./fakes/github";
import type { FakeService } from "./fakes/http";
import { seedTenant, type Tenant } from "./helpers/tenants";
import { gzip, seedRun } from "./logs/helpers";

const ORIGIN = "https://hub.test";
const ACME = 42;
const UMBRELLA = 43;
const GITHUB_USER = { id: 7001, login: "octocat" };
const L = S.dashboard.logs;

let acme: Tenant;
let umbrella: Tenant;
let gh: FakeService;
const restore: (() => void)[] = [];

beforeEach(async () => {
  await clearTables();
  acme = await seedTenant(env, { installationId: ACME, teamId: "T0ACME" });
  umbrella = await seedTenant(env, { installationId: UMBRELLA, teamId: "T0UMBRELLA" });
  gh = createFakeGitHub();
  const installations: Installation[] = [];
  gh.respond("GET", "/user/installations", () => Response.json({ total_count: installations.length, installations }));
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

async function sessionFor(installationIds: number[]): Promise<string> {
  const setCookie = await issueSession(env, { installationIds, githubUserId: GITHUB_USER.id, githubLogin: GITHUB_USER.login }, testClock.now());
  return setCookie.split(";")[0] ?? "";
}

function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7" };
  if (cookie !== undefined) headers.cookie = cookie;
  return exports.default.fetch(`${ORIGIN}${path}`, { headers, redirect: "manual" });
}

const view = (runId: string, job: string, installation = ACME): string => `/${installation}/runs/${runId}/logs/${job}/view`;

/** Seeds a run with one job whose log is text, stored where the job row points. */
async function seedLog(runId: string, job: string, text: string): Promise<void> {
  const key = logKey(ACME, runId, job);
  await seedRun(ACME, acme.repoId, runId, acme.agentId, job);
  await env.LOGS.put(key, await gzip(text));
  await setJobLog(tenantDb(env.DB, ACME), runId, job, { key, bytes: text.length, truncated: false });
}

describe("renderLines", () => {
  const text = (log: string): string[] => renderLines(log).map((l) => l.text);

  it("escapes markup and keeps one entry per line", () => {
    expect(text("<script>alert(1)</script>\n& \"quoted\"\n")).toEqual(["&lt;script&gt;alert(1)&lt;/script&gt;", "&amp; &quot;quoted&quot;"]);
  });

  it("turns SGR colours into spans with fixed classes and carries style across lines until reset", () => {
    expect(text("\x1b[1;32mok\x1b[0m done\n\x1b[31mred\nstill red\x1b[0m\n")).toEqual([
      '<span class="c2 fb">ok</span> done',
      '<span class="c1">red</span>',
      '<span class="c1">still red</span>',
    ]);
  });

  it("never lets an escape sequence or a control character through", () => {
    const [line] = text('a\x1b[2Kb\x1b]0;<b>title</b>\x07c\x07d\x1b[38;2;1;2;3me');
    expect(line).toBe("abcde");
  });

  it("keeps the last state of a carriage-return progress line", () => {
    expect(text("10%\r50%\r100%\n")).toEqual(["100%"]);
  });

  it("returns no lines for an empty log", () => {
    expect(renderLines("")).toEqual([]);
  });

  it("splits the agent's timestamp off each line", () => {
    expect(renderLines("2026-05-05T14:32:01.123Z npm ci\n2026-05-05T14:32:02.000Z <b>done</b>\n")).toEqual([
      { ts: "2026-05-05T14:32:01.123Z", text: "npm ci" },
      { ts: "2026-05-05T14:32:02.000Z", text: "&lt;b&gt;done&lt;/b&gt;" },
    ]);
  });

  it("renders a log without timestamps, as an older agent wrote it, with ts null", () => {
    expect(renderLines("first\nsecond\n")).toEqual([
      { ts: null, text: "first" },
      { ts: null, text: "second" },
    ]);
  });

  it("keeps an empty line after its timestamp", () => {
    expect(renderLines("2026-05-05T14:32:01.123Z \n")).toEqual([{ ts: "2026-05-05T14:32:01.123Z", text: "" }]);
  });

  it("reads the prefix strictly: a near miss stays part of the text", () => {
    const near = [
      "2026-05-05T14:32:01.123Z",
      "2026-05-05T14:32:01.123Zx rest",
      "2026-05-05 14:32:01.123Z rest",
      "2026-05-05T14:32:01Z rest",
      "2026-05-05T14:32:01.123+00:00 rest",
      " 2026-05-05T14:32:01.123Z rest",
      "2026-02-31T14:32:01.123Z rest",
      "2026-13-05T14:32:01.123Z rest",
      "2026-05-05T24:32:01.123Z rest",
      "2026-05-05T14:60:01.123Z rest",
    ];
    for (const line of near) expect(renderLines(`${line}\n`)).toEqual([{ ts: null, text: line }]);
  });

  it("handles colours and carriage returns after the prefix", () => {
    expect(renderLines("2026-05-05T14:32:01.123Z \x1b[31mred\x1b[0m\n2026-05-05T14:32:02.000Z 10%\r100%\n")).toEqual([
      { ts: "2026-05-05T14:32:01.123Z", text: '<span class="c1">red</span>' },
      { ts: "2026-05-05T14:32:02.000Z", text: "100%" },
    ]);
  });

  it("mixes stamped and unstamped lines per line", () => {
    expect(renderLines("old\n2026-05-05T14:32:01.123Z new\n")).toEqual([
      { ts: null, text: "old" },
      { ts: "2026-05-05T14:32:01.123Z", text: "new" },
    ]);
  });
});

describe("readLogHead", () => {
  it("stops at the cap on a line boundary and says so", async () => {
    const body = new Blob(["one\ntwo\nthree\n"]).stream();
    expect(await readLogHead(body, 9)).toEqual({ text: "one\ntwo\n", cut: true });
  });

  it("reads a log under the cap whole", async () => {
    expect(await readLogHead(new Blob(["one\ntwo\n"]).stream(), VIEW_BYTES)).toEqual({ text: "one\ntwo\n", cut: false });
  });
});

describe("GET /:installationId/runs/:runId/logs/:job/view", () => {
  it("shows the log with a numbered, linkable line each and a download link", async () => {
    await seedLog("run_view", "build", "first line\nsecond line\n");
    const res = await get(view("run_view", "build"), await sessionFor([ACME]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).not.toContain("unsafe");
    const html = await res.text();
    expect(html).toContain("first line");
    expect(html).toContain("second line");
    expect(html).toContain('id="L1"');
    expect(html).toContain('id="L2"');
    expect(html).toContain('href="#L2"');
    expect(html).toContain(escapeHtml(L.lines(2)));
    expect(html).toMatch(/>Run #\d+<\/a>/);
    expect(html).toContain(`href="/${ACME}/runs/run_view/logs/build/download"`);
    expect(html).toContain(`data-raw="/${ACME}/runs/run_view/logs/build"`);
    expect(html).not.toContain("<script>alert");
  });

  it("escapes a log that carries markup and styles it only through fixed classes", async () => {
    await seedLog("run_xss", "build", '<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n\x1b[31m<b>red</b>\x1b[0m\n');
    const html = await (await get(view("run_xss", "build"), await sessionFor([ACME]))).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>red");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<span class="c1">&lt;b&gt;red&lt;/b&gt;</span>');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it("shows a timestamp cell per line and a Timestamps toggle when the agent stamped the log", async () => {
    await seedLog("run_ts", "build", "2026-05-05T14:32:01.123Z npm ci\n2026-05-05T14:32:07.456Z done\n");
    const html = await (await get(view("run_ts", "build"), await sessionFor([ACME]))).text();
    expect(html).toContain('<span class="ts" title="2026-05-05T14:32:01.123Z">14:32:01</span><span class="t">npm ci</span>');
    expect(html).toContain('<span class="ts" title="2026-05-05T14:32:07.456Z">14:32:07</span><span class="t">done</span>');
    expect(html).toContain(`data-ts aria-pressed="true" data-js hidden>${escapeHtml(L.timestamps)}</button>`);
    expect(html).not.toContain("2026-05-05T14:32:01.123Z npm ci");
    expect(html).not.toMatch(/\sstyle=/);
  });

  it("renders a log without timestamps with no timestamp column and no toggle", async () => {
    await seedLog("run_nots", "build", "first line\nsecond line\n");
    const html = await (await get(view("run_nots", "build"), await sessionFor([ACME]))).text();
    expect(html).toContain('<span class="t">first line</span>');
    expect(html).not.toContain('<span class="ts"');
    expect(html).not.toContain("data-ts ");
  });

  it("leaves the cell empty for an unstamped line in a stamped log", async () => {
    await seedLog("run_mixed", "build", "old line\n2026-05-05T14:32:01.123Z new line\n");
    const html = await (await get(view("run_mixed", "build"), await sessionFor([ACME]))).text();
    expect(html).toContain('<span class="ts"></span><span class="t">old line</span>');
    expect(html).toContain('>14:32:01</span><span class="t">new line</span>');
  });

  it("serves the raw log with its timestamps untouched", async () => {
    const raw = "2026-05-05T14:32:01.123Z npm ci\n";
    await seedLog("run_raw_ts", "build", raw);
    const res = await get(`/${ACME}/runs/run_raw_ts/logs/build`, await sessionFor([ACME]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(raw);
  });

  it("says the log is queued while the job has not uploaded one", async () => {
    await seedRun(ACME, acme.repoId, "run_queued", acme.agentId, "build", { state: "running" });
    await upsertJob(tenantDb(env.DB, ACME), { run_id: "run_queued", name: "build", state: "running", step: null, step_index: null, steps_total: null, duration_ms: null });
    const html = await (await get(view("run_queued", "build"), await sessionFor([ACME]))).text();
    expect(html).toContain(escapeHtml(L.queuedTitle));
    expect(html).not.toContain('class="vb"');
  });

  it("says the log stays on the agent once the agent reported logs: local", async () => {
    await seedRun(ACME, acme.repoId, "run_local", acme.agentId, "build");
    expect(await markJobLogsLocal(tenantDb(env.DB, ACME), "run_local", "build")).toBe(true);
    const html = await (await get(view("run_local", "build"), await sessionFor([ACME]))).text();
    expect(html).toContain(escapeHtml(L.localTitle));
  });

  it("says the log failed when a finished job never uploaded one", async () => {
    await seedRun(ACME, acme.repoId, "run_failed", acme.agentId, "build");
    const html = await (await get(view("run_failed", "build"), await sessionFor([ACME]))).text();
    expect(html).toContain(escapeHtml(L.failedTitle));
  });

  it("says the log failed when the stored object is not gzip", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const key = logKey(ACME, "run_bad", "build");
    await seedRun(ACME, acme.repoId, "run_bad", acme.agentId, "build");
    await env.LOGS.put(key, "not gzip at all");
    await setJobLog(tenantDb(env.DB, ACME), "run_bad", "build", { key, bytes: 15, truncated: false });
    const html = await (await get(view("run_bad", "build"), await sessionFor([ACME]))).text();
    expect(html).toContain(escapeHtml(L.failedTitle));
  });

  it("says the log expired when the stored object is gone", async () => {
    await env.LOGS.delete(acme.logKey);
    const res = await get(view(acme.runId, acme.job), await sessionFor([ACME]));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(escapeHtml(L.expiredTitle));
  });

  it("shows the cut notice and only the head of a log over the cap", async () => {
    const line = `${"x".repeat(1023)}\n`;
    const count = VIEW_BYTES / 1024 + 10;
    await seedLog("run_huge", "build", line.repeat(count));
    const html = await (await get(view("run_huge", "build"), await sessionFor([ACME]))).text();
    expect(html).toContain(escapeHtml(L.cutNote(VIEW_BYTES / 1024)));
    expect(html).toContain(`id="L${VIEW_BYTES / 1024}"`);
    expect(html).not.toContain(`id="L${count}"`);
  });

  it("answers 404 for another installation's run, under either installation, and leaks nothing", async () => {
    const cookie = await sessionFor([ACME]);
    for (const path of [view(umbrella.runId, umbrella.job, UMBRELLA), view(umbrella.runId, umbrella.job, ACME)]) {
      const res = await get(path, cookie);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("secret log");
    }
  });

  it("answers 404 without a session, for an unknown job and for an unknown run", async () => {
    const cookie = await sessionFor([ACME]);
    expect((await get(view(acme.runId, acme.job))).status).toBe(404);
    expect((await get(view(acme.runId, "nope"), cookie)).status).toBe(404);
    expect((await get(view("run_none", "build"), cookie)).status).toBe(404);
  });

  it("never reads an object outside the installation's prefix, even when the row points there", async () => {
    await setJobLog(tenantDb(env.DB, ACME), acme.runId, acme.job, { key: umbrella.logKey, bytes: 10, truncated: false });
    const res = await get(view(acme.runId, acme.job), await sessionFor([ACME]));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("secret log");
  });
});

describe("GET /:installationId/runs/:runId/logs/:job/download", () => {
  it("serves the log as an attachment of inert text", async () => {
    const res = await get(`/${ACME}/runs/${acme.runId}/logs/${acme.job}/download`, await sessionFor([ACME]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${acme.job}.log"`);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(await res.text()).toBe("tenant 42 secret log\n");
  });

  it("keeps the raw route inline", async () => {
    const res = await get(`/${ACME}/runs/${acme.runId}/logs/${acme.job}`, await sessionFor([ACME]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("answers 404 for another installation's log, under either installation", async () => {
    const cookie = await sessionFor([ACME]);
    for (const path of [`/${UMBRELLA}/runs/${umbrella.runId}/logs/${umbrella.job}/download`, `/${ACME}/runs/${umbrella.runId}/logs/${umbrella.job}/download`]) {
      const res = await get(path, cookie);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("secret log");
    }
  });
});

describe("GET /:installationId/runs/:runId/logs/:job/stream", () => {
  it("returns 409 when the run is already finished", async () => {
    const cookie = await sessionFor([ACME]);
    const res = await get(`/${ACME}/runs/${acme.runId}/logs/${acme.job}/stream`, cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "run_finished" });
  });

  it("answers 404 for an unknown run or job", async () => {
    const cookie = await sessionFor([ACME]);
    const resRun = await get(`/${ACME}/runs/does-not-exist/logs/${acme.job}/stream`, cookie);
    expect(resRun.status).toBe(404);
    const resJob = await get(`/${ACME}/runs/${acme.runId}/logs/does-not-exist/stream`, cookie);
    expect(resJob.status).toBe(404);
  });
});

describe("markJobLogsLocal", () => {
  it("marks only the installation's own job", async () => {
    expect(await markJobLogsLocal(tenantDb(env.DB, ACME), umbrella.runId, umbrella.job)).toBe(false);
    const row = await env.DB.prepare("SELECT logs_local FROM jobs WHERE run_id = ?1").bind(umbrella.runId).first<{ logs_local: number }>();
    expect(row?.logs_local).toBe(0);
    expect(await markJobLogsLocal(tenantDb(env.DB, UMBRELLA), umbrella.runId, umbrella.job)).toBe(true);
  });
});
