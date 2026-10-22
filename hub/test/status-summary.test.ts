import { describe, expect, it } from "vitest";
import type { StatusRow } from "../src/db/status";
import { STATUS_WINDOW_DAYS, summarize, windowStartDay } from "../src/status-summary";

const NOW = Date.parse("2026-10-19T20:24:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function row(component: StatusRow["component"], daysAgo: number, ok: number, total: number, lastOk = 1): StatusRow {
  const at = NOW - daysAgo * DAY_MS;
  return {
    component,
    day: new Date(at).toISOString().slice(0, 10),
    checks_ok: ok,
    checks_total: total,
    last_checked_at: at,
    last_ok: lastOk,
    last_latency_ms: 12,
  };
}

function component(rows: StatusRow[], name: StatusRow["component"]) {
  const found = summarize(rows, NOW).components.find((c) => c.component === name);
  if (!found) throw new Error(`no ${name} summary`);
  return found;
}

describe("windowStartDay", () => {
  it("is the oldest of the 41 days that end with today", () => {
    expect(STATUS_WINDOW_DAYS).toBe(41);
    expect(windowStartDay(NOW)).toBe("2026-09-09");
  });
});

describe("summarize", () => {
  it("with no rows has no data: overall none, a dash instead of an uptime, 41 empty bars per component", () => {
    const summary = summarize([], NOW);
    expect(summary.overall).toBe("none");
    expect(summary.lastCheckedAt).toBeNull();
    expect(summary.components.map((c) => c.component)).toEqual(["api", "agents", "logs"]);
    for (const c of summary.components) {
      expect(c.health).toBe("none");
      expect(c.uptime).toBeNull();
      expect(c.bars).toHaveLength(41);
      expect(c.bars.every((b) => b.health === "none" && b.total === 0)).toBe(true);
    }
  });

  it("orders the bars oldest first and ends with today", () => {
    const bars = component([], "api").bars;
    expect(bars[0]?.day).toBe("2026-09-09");
    expect(bars[40]?.day).toBe("2026-10-19");
  });

  it("colors a day operational when every check passed, degraded when some failed, outage when most failed", () => {
    const rows = [row("api", 0, 10, 10), row("api", 1, 9, 10), row("api", 2, 4, 10), row("api", 3, 5, 10)];
    const bars = component(rows, "api").bars;
    expect(bars[40]?.health).toBe("operational");
    expect(bars[39]?.health).toBe("degraded");
    expect(bars[38]?.health).toBe("outage");
    expect(bars[37]?.health).toBe("degraded");
  });

  it("leaves days without a row as no data", () => {
    const bars = component([row("api", 0, 1, 1)], "api").bars;
    expect(bars[39]).toMatchObject({ health: "none", total: 0 });
  });

  it("marks a failed day recovered only when its last check passed", () => {
    const rows = [row("api", 1, 9, 10, 1), row("api", 2, 9, 10, 0), row("api", 3, 10, 10, 1)];
    const bars = component(rows, "api").bars;
    expect(bars[39]?.recovered).toBe(true);
    expect(bars[38]?.recovered).toBe(false);
    expect(bars[37]?.recovered).toBe(false);
  });

  it("lists incidents newest day first from failed days in the last 30 days only", () => {
    const rows = [row("api", 2, 9, 10), row("logs", 2, 8, 10), row("api", 5, 10, 10), row("agents", 35, 0, 10)];
    const { incidents } = summarize(rows, NOW);
    expect(incidents).toEqual([
      { component: "api", day: "2026-10-17", failed: 1, total: 10 },
      { component: "logs", day: "2026-10-17", failed: 2, total: 10 },
    ]);
  });

  it("ignores rows older than the window", () => {
    const old = row("api", 45, 0, 100);
    expect(component([old], "api").uptime).toBeNull();
  });

  it("sums checks over the window for the uptime", () => {
    expect(component([row("api", 0, 50, 100), row("api", 1, 100, 100)], "api").uptime).toBe("75.00");
  });

  it("rounds the uptime down so one failed check is never 100.00", () => {
    expect(component([row("api", 0, 9999, 10000)], "api").uptime).toBe("99.99");
    expect(component([row("api", 0, 99999, 100000)], "api").uptime).toBe("99.99");
    expect(component([row("api", 0, 288, 288)], "api").uptime).toBe("100.00");
    expect(component([row("api", 0, 0, 5)], "api").uptime).toBe("0.00");
  });

  it("is operational when the newest probe of every component passed", () => {
    const rows = [row("api", 0, 5, 5), row("agents", 0, 5, 5), row("logs", 0, 5, 5)];
    const summary = summarize(rows, NOW);
    expect(summary.overall).toBe("operational");
    expect(summary.components.every((c) => c.health === "operational")).toBe(true);
  });

  it("stays operational from a failed day behind a passing newest probe", () => {
    const rows = [row("api", 3, 0, 10, 0), row("api", 0, 5, 5, 1), row("agents", 0, 1, 1), row("logs", 0, 1, 1)];
    expect(summarize(rows, NOW).overall).toBe("operational");
  });

  it("is degraded when a non-API component's newest probe failed", () => {
    const rows = [row("api", 0, 5, 5), row("agents", 0, 4, 5, 0), row("logs", 0, 5, 5)];
    const summary = summarize(rows, NOW);
    expect(summary.overall).toBe("degraded");
    expect(summary.components.find((c) => c.component === "agents")?.health).toBe("degraded");
    expect(summary.components.find((c) => c.component === "api")?.health).toBe("operational");
  });

  it("is an outage when the API's newest probe failed", () => {
    const rows = [row("api", 0, 4, 5, 0), row("agents", 0, 5, 5), row("logs", 0, 5, 5)];
    const summary = summarize(rows, NOW);
    expect(summary.overall).toBe("outage");
    expect(summary.components.find((c) => c.component === "api")?.health).toBe("outage");
  });

  it("is an outage when every component with data failed", () => {
    const rows = [row("agents", 0, 0, 3, 0), row("logs", 0, 0, 3, 0)];
    expect(summarize(rows, NOW).overall).toBe("outage");
  });

  it("reports the newest check time over all rows", () => {
    expect(summarize([row("api", 2, 1, 1), row("logs", 0, 1, 1)], NOW).lastCheckedAt).toBe(NOW);
  });
});
