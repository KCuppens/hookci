import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertInstallation } from "../src/db/installations";
import { LOG_URL_TTL_SECONDS, signLogUrl } from "../src/logs/sign";
import { errorPage } from "../src/pages/error";
import { escapeHtml } from "../src/pages/layout";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { gzip, seedAgent, seedRun } from "./logs/helpers";

const ID_FORMAT = /req_[0-9A-Z]{20}/;
const INSTALLATION = 41;
const OTHER = 42;
const RUN = "run_err_1";
const OTHER_RUN = "run_err_2";
const SECRET_LOG = "token=do-not-leak-this-line\n";

async function page(code: string, status = 400): Promise<{ res: Response; html: string }> {
  const res = await errorPage(code, status);
  return { res, html: await res.text() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("error page variants", () => {
  it.each([
    ["oauth_state_invalid", "t-red", "/start", S.errorPage.actions.restart],
    ["github_no_access", "t-coral", "/app/login", S.errorPage.actions.signIn],
    ["log_expired", "t-blue", "/app", S.errorPage.actions.dashboard],
    ["log_sig_invalid", "t-red", "/app", S.errorPage.actions.dashboard],
    ["log_not_found", "t-slate", "/app", S.errorPage.actions.dashboard],
    ["rate_limited", "t-amber", "/app", S.errorPage.actions.dashboard],
  ] as const)("renders %s with its tone, copy and action", async (code, tone, href, label) => {
    const { res, html } = await page(code);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain(`class="ei ${tone}"`);
    expect(html).toContain(`<p class="ec">${code}</p>`);
    expect(html).toContain(`<h1>${escapeHtml(S.errorPage.codes[code].title)}</h1>`);
    for (const line of S.errorPage.codes[code].lines) expect(html).toContain(`<span>${escapeHtml(line)}</span>`);
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain(escapeHtml(label));
    expect(html).toContain(escapeHtml(S.errorPage.requestId));
  });

  it("draws each variant's own traced glyph inline, with no sprite reference and a traced copy icon", async () => {
    const glyphs = new Set<string>();
    for (const code of ["oauth_state_invalid", "github_no_access", "log_expired", "log_sig_invalid", "log_not_found", "rate_limited"]) {
      const { html } = await page(code);
      const glyph = html.match(/<svg class="gl" viewBox="0 0 86 86"[^>]*><path d="([^"]+)"\/><\/svg>/)?.[1];
      expect(glyph).toBeTruthy();
      glyphs.add(glyph ?? "");
      expect(html).toMatch(/<svg class="cc" viewBox="0 0 24 24"[^>]*><path d="[^"]+"\/><\/svg>/);
    }
    expect(glyphs.size).toBe(6);
  });

  it("covers every code the hub emits with copy of its own, never the fallback", () => {
    for (const code of [
      "oauth_state_invalid",
      "github_no_access",
      "installation_admin_required",
      "github_oauth_failed",
      "github_error",
      "github_unavailable",
      "slack_oauth_failed",
      "slack_scope_mismatch",
      "log_expired",
      "log_sig_invalid",
      "log_not_found",
      "rate_limited",
      "pair_rate_limited",
    ] as const) {
      expect(S.errorPage.codes[code].title).not.toBe("");
      expect(S.errorPage.codes[code].lines.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the generic exclamation card for a code it has no copy for, keeping the status", async () => {
    const { res, html } = await page("some_unknown_code", 500);
    expect(res.status).toBe(500);
    expect(html).toContain(`<h1>${escapeHtml(S.errorPage.fallback.title)}</h1>`);
    expect(html).toContain('class="ei t-red"');
    expect(html).toContain('href="/start"');
  });

  it("escapes a hostile code in the code line and the title", async () => {
    const hostile = `"><script>alert(1)</script>`;
    const { html } = await page(hostile);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain(escapeHtml(hostile));
  });
});

describe("error page request id", () => {
  it("shows the same fresh id in the body and the X-Request-Id header", async () => {
    const first = await page("log_expired", 410);
    const second = await page("log_expired", 410);
    const idOf = (html: string) => html.match(ID_FORMAT)?.[0];
    expect(idOf(first.html)).toBeDefined();
    expect(first.res.headers.get("x-request-id")).toBe(idOf(first.html));
    expect(second.res.headers.get("x-request-id")).toBe(idOf(second.html));
    expect(idOf(first.html)).not.toBe(idOf(second.html));
  });

  it("logs the id with the code and status and nothing else", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { res } = await page("log_sig_invalid", 403);
    const entries = spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(entries).toEqual([{ request_id: res.headers.get("x-request-id"), code: "log_sig_invalid", status: 403, level: "info", event: "error_page" }]);
  });
});

describe("error page security headers", () => {
  it("has a script hash in the CSP, no inline style attribute and no form action", async () => {
    const { res, html } = await page("rate_limited", 429);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toContain("onclick=");
    expect(html).not.toContain("<form");
  });
});

describe("GET /logs/:runId/:job as a browser", () => {
  beforeEach(async () => {
    await clearTables();
    for (const id of [INSTALLATION, OTHER]) {
      await upsertInstallation(env.DB, { id, account_login: `acct${id}`, account_type: "Organization", account_id: id * 10, created_at: 1 });
    }
    await seedAgent(INSTALLATION, "agt_err_owner");
    await seedAgent(OTHER, "agt_err_other");
    await seedRun(INSTALLATION, 4100, RUN, "agt_err_owner");
    await seedRun(OTHER, 4200, OTHER_RUN, "agt_err_other");
    await env.LOGS.put(`logs/${OTHER}/${OTHER_RUN}/test.log.gz`, await gzip(SECRET_LOG));
  });

  const browser = { headers: { accept: "text/html,application/xhtml+xml" } };

  it("answers an expired link with the 410 error page", async () => {
    const url = await signLogUrl(env, RUN, "test");
    testClock.advance(LOG_URL_TTL_SECONDS * 1000);
    const res = await exports.default.fetch(url, browser);
    const html = await res.text();
    expect(res.status).toBe(410);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain(escapeHtml(S.errorPage.codes.log_expired.title));
    expect(res.headers.get("x-request-id")).toMatch(ID_FORMAT);
  });

  it("answers a tampered signature with the 403 error page and no log bytes", async () => {
    const url = new URL(await signLogUrl(env, RUN, "test"));
    const sig = url.searchParams.get("sig") ?? "";
    url.searchParams.set("sig", `${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`);
    const res = await exports.default.fetch(url, browser);
    const html = await res.text();
    expect(res.status).toBe(403);
    expect(html).toContain(escapeHtml(S.errorPage.codes.log_sig_invalid.title));
    expect(html).not.toContain(SECRET_LOG.trim());
  });

  it("refuses another installation's run through this run's signature without leaking its log", async () => {
    const url = (await signLogUrl(env, RUN, "test")).replace(`/${RUN}/`, `/${OTHER_RUN}/`);
    const res = await exports.default.fetch(url, browser);
    const html = await res.text();
    expect(res.status).toBe(403);
    expect(html).toContain(escapeHtml(S.errorPage.codes.log_sig_invalid.title));
    expect(html).not.toContain("do-not-leak");
  });

  it("answers a job without a stored log with the 404 error page", async () => {
    const res = await exports.default.fetch(await signLogUrl(env, RUN, "lint"), browser);
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(html).toContain(escapeHtml(S.errorPage.codes.log_not_found.title));
  });

  it("keeps the JSON error for a client that does not ask for HTML", async () => {
    const url = await signLogUrl(env, RUN, "lint");
    const res = await exports.default.fetch(url);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "log_not_found" });
  });
});
