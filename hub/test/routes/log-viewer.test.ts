import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertInstallation } from "../../src/db/installations";
import { upsertRepos } from "../../src/db/repos";
import { tenantDb } from "../../src/db/tenant";
import { logKey } from "../../src/logs/keys";
import { LOG_URL_TTL_SEC, type LogRef, signLogUrl } from "../../src/logs/signing";
import { escapeHtml } from "../../src/pages/layout";
import { RENDER_LIMIT_MIB } from "../../src/routes/log-viewer";
import { S } from "../../src/strings";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { gunzip, gzip, seedRun } from "../logs/helpers";

const A = 51;
const B = 52;
const RUN_A = "run_viewer_a";
const RUN_B = "run_viewer_b";
const REF: LogRef = { installationId: A, runId: RUN_A, job: "test" };
const LOG = 'go test ./...\n\x1b[31m--- FAIL: TestHub\x1b[0m\n<script>alert("x")</script>\n';

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
};

beforeEach(async () => {
  await clearTables();
  for (const [id, repoId, fullName, runId] of [
    [A, 5100, "acme/widgets", RUN_A],
    [B, 5200, "other/api", RUN_B],
  ] as const) {
    await upsertInstallation(env.DB, { id, account_login: `acct${id}`, account_type: "Organization", account_id: id * 10, created_at: 1 });
    await upsertRepos(tenantDb(env.DB, id), [{ repo_id: repoId, full_name: fullName, default_branch: "main" }]);
    await seedRun(id, repoId, runId, null);
    await env.LOGS.put(logKey(id, runId, "test"), await gzip(LOG));
  }
});

async function signed(ref: LogRef = REF): Promise<string> {
  return signLogUrl(env, ref, new Date(testClock.now()));
}

function fetchHub(url: string): Promise<Response> {
  return exports.default.fetch(url, { encodeResponseBody: "manual" });
}

function expectSecurityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), name).toBe(value);
}

async function expectLinkExpired(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expectSecurityHeaders(res);
  expect(await res.text()).toContain(escapeHtml(S.logViewer.linkExpired));
}

describe("GET /logs/view", () => {
  it("renders the log as escaped, coloured HTML under the five security headers", async () => {
    const url = await signed();
    const res = await fetchHub(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expectSecurityHeaders(res);
    const html = await res.text();
    expect(html).toContain("<h1>acme/widgets</h1>");
    expect(html).toContain(`<code>${RUN_A}</code>`);
    expect(html).toContain("<code>test</code>");
    expect(html).toContain('<span class="c-red">--- FAIL: TestHub</span>');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).toContain('<link rel="stylesheet" href="/logs/viewer.css">');
    expect(html).toContain(`href="${escapeHtml(url.replace(`${env.HUB_ORIGIN}/logs/view`, "/logs/raw"))}"`);
  });

  it("renders the first 5 MiB and points to the raw log for the rest", async () => {
    const line = `${"a".repeat(1023)}\n`;
    await env.LOGS.put(logKey(A, RUN_A, "test"), await gzip(`${line.repeat(6 * 1024)}END-OF-LOG\n`));
    const html = await (await fetchHub(await signed())).text();
    expect(html).toContain(escapeHtml(S.logViewer.truncated(RENDER_LIMIT_MIB)));
    expect(html).toContain(escapeHtml(S.logViewer.downloadRaw));
    expect(html).not.toContain("END-OF-LOG");
    const pre = /<pre class="log">([^<]*)<\/pre>/.exec(html)?.[1] ?? "";
    expect(pre).toBe(line.repeat(5 * 1024));
  });

  it("answers the link-expired page once the link is past its 15 minutes", async () => {
    const url = await signed();
    testClock.advance((LOG_URL_TTL_SEC + 1) * 1000);
    await expectLinkExpired(await fetchHub(url));
  });

  it("answers the link-expired page to a changed signature", async () => {
    const url = new URL(await signed());
    const sig = url.searchParams.get("sig") ?? "";
    url.searchParams.set("sig", `${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`);
    await expectLinkExpired(await fetchHub(url.toString()));
  });

  it("answers the link-expired page to a link signed for installation A naming B's run", async () => {
    await expectLinkExpired(await fetchHub(await signed({ installationId: A, runId: RUN_B, job: "test" })));
  });

  it("answers 404 with the retention note when the job has no stored log", async () => {
    await env.LOGS.delete(logKey(A, RUN_A, "test"));
    const res = await fetchHub(await signed());
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expectSecurityHeaders(res);
    expect(await res.text()).toContain("Log expired (14-day retention) or kept local on the agent.");
  });
});

describe("GET /logs/raw", () => {
  const rawUrl = async (ref?: LogRef): Promise<string> => (await signed(ref)).replace("/logs/view?", "/logs/raw?");

  it("serves the log as inline text/plain", async () => {
    const res = await fetchHub(await rawUrl());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expectSecurityHeaders(res);
    expect(await gunzip(await res.arrayBuffer())).toBe(LOG);
  });

  it("answers the link-expired page to a link signed for installation A naming B's run", async () => {
    await expectLinkExpired(await fetchHub(await rawUrl({ installationId: A, runId: RUN_B, job: "test" })));
  });

  it("answers 404 when the job has no stored log", async () => {
    expect((await fetchHub(await rawUrl({ ...REF, job: "lint" }))).status).toBe(404);
  });
});

describe("GET /logs/viewer.css", () => {
  it("serves the stylesheet with light and dark colour schemes", async () => {
    const res = await fetchHub("https://hub.test/logs/viewer.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expectSecurityHeaders(res);
    const css = await res.text();
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(".c-red");
  });
});
