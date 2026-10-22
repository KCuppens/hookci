import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadStatusRows, recordStatusChecks, STATUS_RETENTION_DAYS, type StatusRow } from "../../src/db/status";
import { type Probes, realProbes, runStatusChecks } from "../../src/cron/status-check";
import { clearTables } from "../db/helpers";

const NOW = Date.parse("2026-10-19T20:24:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const passing: Probes = { api: async () => {}, agents: async () => {}, logs: async () => {} };

async function allRows(): Promise<StatusRow[]> {
  return loadStatusRows(env.DB, "0000-00-00");
}

beforeEach(async () => {
  await clearTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runStatusChecks", () => {
  it("records one passing check per component under the UTC day of now", async () => {
    const checks = await runStatusChecks(env, NOW, passing);
    expect(checks.map((c) => [c.component, c.ok])).toEqual([
      ["api", true],
      ["agents", true],
      ["logs", true],
    ]);
    const rows = await allRows();
    expect(rows.map((r) => [r.component, r.day, r.checks_ok, r.checks_total, r.last_ok, r.last_checked_at])).toEqual([
      ["agents", "2026-10-19", 1, 1, 1, NOW],
      ["api", "2026-10-19", 1, 1, 1, NOW],
      ["logs", "2026-10-19", 1, 1, 1, NOW],
    ]);
  });

  it("counts a rejecting probe as a failed check and keeps the others passing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const probes: Probes = {
      ...passing,
      agents: async () => {
        throw new Error("do unreachable");
      },
    };
    const checks = await runStatusChecks(env, NOW, probes);
    expect(checks.find((c) => c.component === "agents")?.ok).toBe(false);
    expect(checks.filter((c) => c.ok)).toHaveLength(2);
    expect(errors).toHaveBeenCalled();
    const agents = (await allRows()).find((r) => r.component === "agents");
    expect(agents).toMatchObject({ checks_ok: 0, checks_total: 1, last_ok: 0 });
  });

  it("accumulates checks within a day and tracks the newest result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runStatusChecks(env, NOW, passing);
    await runStatusChecks(env, NOW + 5 * 60_000, { ...passing, api: () => Promise.reject(new Error("d1 down")) });
    const api = (await allRows()).find((r) => r.component === "api");
    expect(api).toMatchObject({ checks_ok: 1, checks_total: 2, last_ok: 0, last_checked_at: NOW + 5 * 60_000 });
  });

  it("starts a new row on the next UTC day", async () => {
    await runStatusChecks(env, Date.parse("2026-10-19T23:59:00Z"), passing);
    await runStatusChecks(env, Date.parse("2026-10-20T00:01:00Z"), passing);
    const days = (await allRows()).filter((r) => r.component === "api").map((r) => r.day);
    expect(days).toEqual(["2026-10-19", "2026-10-20"]);
  });

  it("does not hang on a probe that never answers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const pending = runStatusChecks(env, NOW, { ...passing, logs: () => new Promise(() => {}) });
      await vi.advanceTimersByTimeAsync(10_001);
      const checks = await pending;
      expect(checks.find((c) => c.component === "logs")?.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("recordStatusChecks retention", () => {
  it("drops rows older than the retention and keeps newer ones", async () => {
    const oldDay = NOW - (STATUS_RETENTION_DAYS + 1) * DAY_MS;
    const keptDay = NOW - (STATUS_RETENTION_DAYS - 1) * DAY_MS;
    await recordStatusChecks(env.DB, [{ component: "api", ok: true, latencyMs: 3 }], oldDay);
    await recordStatusChecks(env.DB, [{ component: "api", ok: true, latencyMs: 3 }], keptDay);
    await recordStatusChecks(env.DB, [{ component: "api", ok: true, latencyMs: 3 }], NOW);
    const days = (await allRows()).map((r) => r.day);
    expect(days).toEqual([new Date(keptDay).toISOString().slice(0, 10), "2026-10-19"]);
  });
});

describe("realProbes", () => {
  it("answer against the test bindings", async () => {
    const probes = realProbes(env);
    await expect(probes.api()).resolves.toBeUndefined();
    await expect(probes.logs()).resolves.toBeNull();
    await expect(probes.agents()).resolves.toBeUndefined();
  });
});
