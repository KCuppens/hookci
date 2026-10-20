import { describe, expect, it } from "vitest";
import { ulid } from "../src/ulid";

describe("ulid", () => {
  it("is 26 lowercase Crockford base32 characters", () => {
    for (let i = 0; i < 100; i++) expect(ulid()).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it("encodes the millisecond time in the first 10 characters", () => {
    // The reference example from the ULID spec, lowercased.
    expect(ulid(1_469_918_176_385).slice(0, 10)).toBe("01aryz6s41");
    expect(ulid(0).slice(0, 10)).toBe("0000000000");
    expect(ulid(2 ** 48 - 1).slice(0, 10)).toBe("7zzzzzzzzz");
  });

  it("sorts ids of a later millisecond after earlier ones", () => {
    const times = [0, 1, 31, 32, 1_767_225_600_000, 1_767_225_600_001, 2 ** 48 - 1];
    const ids = times.map((t) => ulid(t));
    expect([...ids].sort()).toEqual(ids);
  });

  it("differs in the random part within one millisecond", () => {
    const ids = new Set(Array.from({ length: 100 }, () => ulid(1_767_225_600_000)));
    expect(ids.size).toBe(100);
  });

  it("rejects times outside 48 bits", () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(2 ** 48)).toThrow(RangeError);
    expect(() => ulid(1.5)).toThrow(RangeError);
  });
});
