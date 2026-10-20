import { describe, expect, it } from "vitest";
import { PROTOCOL_MAX, PROTOCOL_MIN, negotiate } from "../../src/do/agent-protocol";

describe("negotiate", () => {
  // A hub at protocol N = 2 accepts N and N - 1.
  const N = 2;

  it("accepts N and N-1", () => {
    expect(negotiate({ protocol_version: N }, N - 1, N)).toEqual({ ok: true, protocol: N });
    expect(negotiate({ protocol_version: N - 1 }, N - 1, N)).toEqual({ ok: true, protocol: N - 1 });
  });

  it("refuses N+1 and N-2 with protocol_unsupported and the upgrade hint", () => {
    for (const version of [N + 1, N - 2]) {
      const result = negotiate({ protocol_version: version }, N - 1, N);
      expect(result).toMatchObject({
        ok: false,
        error: { v: 1, type: "error", code: "protocol_unsupported", upgrade_hint: "run: sudo zeroci upgrade" },
      });
    }
  });

  it("refuses a version that is not an integer", () => {
    for (const version of ["1", 1.5, null]) {
      expect(negotiate({ protocol_version: version }, N - 1, N).ok).toBe(false);
    }
  });

  it("defaults to the hub's own range, never below 1", () => {
    expect(PROTOCOL_MIN).toBe(Math.max(1, PROTOCOL_MAX - 1));
    expect(negotiate({ protocol_version: PROTOCOL_MAX })).toEqual({ ok: true, protocol: PROTOCOL_MAX });
    expect(negotiate({ protocol_version: PROTOCOL_MIN })).toEqual({ ok: true, protocol: PROTOCOL_MIN });
    expect(negotiate({ protocol_version: PROTOCOL_MAX + 1 }).ok).toBe(false);
    expect(negotiate({ protocol_version: PROTOCOL_MIN - 1 }).ok).toBe(false);
  });
});
