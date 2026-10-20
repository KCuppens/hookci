import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { checkQuota, QUOTAS, quotaLimit, type TenantQuota } from "../src/quotas";

const lifted: TenantQuota[] = ["runsPerDay", "agentsPerInstallation", "pairTokensPerHour", "slackCmdsPerMin"];
const hub = (mode: string | undefined): Env => ({ ...(env as Env), HUB_MODE: mode });

describe("quotas", () => {
  it.each(lifted)("self_hosted lifts %s", (quota) => {
    expect(quotaLimit(hub("self_hosted"), quota)).toBe(Infinity);
    expect(checkQuota(hub("self_hosted"), quota, QUOTAS[quota] * 1000)).toBe(true);
  });

  it("self_hosted still enforces logBytes", () => {
    expect(quotaLimit(hub("self_hosted"), "logBytes")).toBe(QUOTAS.logBytes);
    expect(checkQuota(hub("self_hosted"), "logBytes", QUOTAS.logBytes)).toBe(true);
    expect(checkQuota(hub("self_hosted"), "logBytes", QUOTAS.logBytes + 1)).toBe(false);
  });

  it.each(["shared", undefined, "", "SELF_HOSTED", "selfhosted"])("HUB_MODE %j keeps every shared limit", (mode) => {
    for (const quota of [...lifted, "logBytes"] as TenantQuota[]) {
      expect(quotaLimit(hub(mode), quota)).toBe(QUOTAS[quota]);
      expect(checkQuota(hub(mode), quota, QUOTAS[quota])).toBe(true);
      expect(checkQuota(hub(mode), quota, QUOTAS[quota] + 1)).toBe(false);
    }
  });
});
