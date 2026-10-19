import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hitIpRate } from "../../src/db/ip-rate";
import { clearTables } from "./helpers";

const MINUTE = 60_000;
// 10 s into a minute window.
const NOW = 1_700_000_050_000;

beforeEach(clearTables);

describe("hitIpRate", () => {
  it("allows limit hits per window, then refuses with the seconds left", async () => {
    for (let i = 0; i < 3; i++) expect(await hitIpRate(env.DB, "a", 3, MINUTE, NOW + i)).toEqual({ ok: true });
    expect(await hitIpRate(env.DB, "a", 3, MINUTE, NOW + 3)).toEqual({ ok: false, retryAfterSeconds: 50 });
    expect(await hitIpRate(env.DB, "a", 3, MINUTE, NOW + 49_500)).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it("starts a fresh count in the next window", async () => {
    for (let i = 0; i < 4; i++) await hitIpRate(env.DB, "a", 3, MINUTE, NOW);
    expect(await hitIpRate(env.DB, "a", 3, MINUTE, NOW + 50_000)).toEqual({ ok: true });
  });

  it("counts each bucket separately", async () => {
    for (let i = 0; i < 3; i++) await hitIpRate(env.DB, "a", 3, MINUTE, NOW);
    expect(await hitIpRate(env.DB, "b", 3, MINUTE, NOW)).toEqual({ ok: true });
    expect(await hitIpRate(env.DB, "a", 3, MINUTE, NOW)).toMatchObject({ ok: false });
  });
});
