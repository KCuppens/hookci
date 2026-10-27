import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Probes, runStatusChecks } from "../../src/cron/status-check";
import { S } from "../../src/strings";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { withoutThemeScript } from "../helpers/theme";

const passing: Probes = { api: async () => {}, agents: async () => {}, logs: async () => {} };

async function status(): Promise<{ res: Response; body: string }> {
  const res = await exports.default.fetch("https://hub.test/status");
  return { res, body: await res.text() };
}

beforeEach(async () => {
  await clearTables();
});

describe("GET /status", () => {
  it("serves the page without a session, with the security headers and a short public cache", async () => {
    const { res, body } = await status();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(body).toContain(S.status.title);
    expect(withoutThemeScript(body)).not.toContain("<script");
  });

  it("credits HookCI in the footer with an external link and ships the traced glyph symbols", async () => {
    const { body } = await status();
    expect(body).toContain(`<a class="pw" href="${S.site.githubUrl}" rel="noopener noreferrer">${S.status.poweredBy}`);
    for (const id of ["bell", "stack", "laptop", "doc", "notebook", "dash", "ext"]) {
      expect(body).toContain(`<symbol id="i-${id}"`);
    }
  });

  it("before any check ran shows the empty banner, no uptime and no checked time", async () => {
    const { body } = await status();
    expect(body).toContain(S.status.banner.none.title);
    expect(body).toContain(S.status.noChecksYet);
    expect(body).toContain(S.status.noData);
    expect(body).not.toContain("<time");
    expect(body.match(/<li class="b h-none"/g)).toHaveLength(123);
  });

  it("after a passing check shows the operational banner, each component and 100.00 uptime", async () => {
    await runStatusChecks(env, testClock.now(), passing);
    const { body } = await status();
    expect(body).toContain(S.status.banner.operational.title);
    for (const c of Object.values(S.status.components)) {
      expect(body).toContain(c.name);
      expect(body).toContain(c.description);
    }
    expect(body).toContain("<time");
    expect(body.match(/100\.00/g)).toHaveLength(3);
    expect(body.match(/<li class="b h-operational"/g)).toHaveLength(3);
    expect(body.match(/<li class="b h-none"/g)).toHaveLength(120);
    expect(body).toContain(S.status.noIncidents);
  });

  it("shows an outage when the API probe failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runStatusChecks(env, testClock.now(), { ...passing, api: () => Promise.reject(new Error("d1 down")) });
    const { body } = await status();
    expect(body).toContain(S.status.banner.outage.title);
    expect(body).toContain("0.00");
    expect(body.match(/<li class="b h-outage"/g)).toHaveLength(1);
  });

  it("shows a degradation when only another component failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runStatusChecks(env, testClock.now(), { ...passing, logs: () => Promise.reject(new Error("r2 down")) });
    const { body } = await status();
    expect(body).toContain(S.status.banner.degraded.title);
  });
});
