import { describe, expect, it } from "vitest";
import { hex, hmacSha256, randomToken, redact, sha256Hex, timingSafeEqual } from "../src/crypto";

describe("timingSafeEqual", () => {
  it.each([
    ["equal strings", "sha256=abc123", "sha256=abc123", true],
    ["both empty", "", "", true],
    ["equal multibyte strings", "café", "café", true],
    ["same length, last byte differs", "sha256=abc123", "sha256=abc124", false],
    ["same length, first byte differs", "xha256=abc123", "sha256=abc123", false],
    ["b is a prefix of a", "sha256=abc123", "sha256=abc", false],
    ["a is a prefix of b", "sha256=abc", "sha256=abc123", false],
    ["a empty", "", "x", false],
    ["b ends in zero bytes padding would add", "abc\0", "abc", false],
    ["same characters, different UTF-8 bytes", "café", "cafe\u0301", false],
  ])("%s", (_name, a, b, want) => {
    expect(timingSafeEqual(a, b)).toBe(want);
  });
});

describe("redact", () => {
  it.each(["ghs_", "ghp_", "gho_", "ghu_", "xoxb-", "xoxp-", "hci_pair_", "hci_agent_"])("masks %s tokens", (prefix) => {
    const secret = `${prefix}Ab12_cd-34EF`;
    const out = redact(`Authorization: Bearer ${secret} (retry)`);
    expect(out).toBe(`Authorization: Bearer ${prefix}[redacted] (retry)`);
  });

  it("masks every token in a string", () => {
    expect(redact("ghs_aaa then xoxb-1-2-bbb")).toBe("ghs_[redacted] then xoxb-[redacted]");
  });

  it("leaves text without tokens unchanged", () => {
    expect(redact("installation 42 run 01jz")).toBe("installation 42 run 01jz");
  });
});

describe("randomToken", () => {
  it("is the prefix plus 26 lowercase base32 characters for 16 bytes", () => {
    const token = randomToken("hci_pair_");
    expect(token).toMatch(/^hci_pair_[a-z2-7]{26}$/);
  });

  it("encodes the requested number of bytes", () => {
    expect(randomToken("hci_agent_", 32)).toMatch(/^hci_agent_[a-z2-7]{52}$/);
    expect(randomToken("", 5)).toMatch(/^[a-z2-7]{8}$/);
  });

  it("does not repeat", () => {
    expect(randomToken("hci_pair_")).not.toBe(randomToken("hci_pair_"));
  });
});

describe("hashes", () => {
  it("hmacSha256 matches RFC 4231 test case 2", async () => {
    const mac = await hmacSha256("Jefe", "what do ya want for nothing?");
    expect(hex(mac)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("hmacSha256 accepts binary key and data", async () => {
    const enc = new TextEncoder();
    const key = Uint8Array.from(enc.encode("Jefe")).buffer;
    const data = Uint8Array.from(enc.encode("what do ya want for nothing?")).buffer;
    expect(hex(await hmacSha256(key, data))).toBe(hex(await hmacSha256("Jefe", "what do ya want for nothing?")));
  });

  it("sha256Hex hashes UTF-8 input", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
