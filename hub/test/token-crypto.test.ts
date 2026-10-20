import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, parseEncKeys } from "../src/crypto";

function base64Key(fill: number, length = 32): string {
  return btoa(String.fromCharCode(...new Uint8Array(length).fill(fill)));
}

const KEYS = parseEncKeys(JSON.stringify({ current: 2, keys: { "1": base64Key(1), "2": base64Key(2) } }));
const TOKEN = "xoxb-1111-2222-abcdefghijklmnop";
const AAD = "workspace:T0001";

describe("token encryption", () => {
  it("round trips under the current key with a fresh IV each time", async () => {
    const first = await encryptToken(KEYS, TOKEN, AAD);
    const second = await encryptToken(KEYS, TOKEN, AAD);
    expect(first.keyVersion).toBe(2);
    expect(first.ct.byteLength).toBe(12 + TOKEN.length + 16);
    expect(first.ct.slice(0, 12)).not.toEqual(second.ct.slice(0, 12));
    expect(await decryptToken(KEYS, first.ct, first.keyVersion, AAD)).toBe(TOKEN);
  });

  it("decrypts with an older key version", async () => {
    const old = parseEncKeys(JSON.stringify({ current: 1, keys: { "1": base64Key(1) } }));
    const { ct, keyVersion } = await encryptToken(old, TOKEN, AAD);
    expect(keyVersion).toBe(1);
    expect(await decryptToken(KEYS, ct, 1, AAD)).toBe(TOKEN);
  });

  it("throws for another team's aad", async () => {
    const { ct, keyVersion } = await encryptToken(KEYS, TOKEN, AAD);
    await expect(decryptToken(KEYS, ct, keyVersion, "workspace:T0002")).rejects.toMatchObject({ code: "token_decrypt_failed", status: 500 });
  });

  it("throws when one ciphertext byte is flipped", async () => {
    const { ct, keyVersion } = await encryptToken(KEYS, TOKEN, AAD);
    for (const index of [0, 12, ct.byteLength - 1]) {
      const tampered = ct.slice();
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      await expect(decryptToken(KEYS, tampered, keyVersion, AAD)).rejects.toMatchObject({ code: "token_decrypt_failed" });
    }
  });

  it("throws when the key version is not in TOKEN_ENC_KEYS", async () => {
    const { ct } = await encryptToken(KEYS, TOKEN, AAD);
    await expect(decryptToken(KEYS, ct, 3, AAD)).rejects.toMatchObject({ code: "enc_keys_invalid", status: 500 });
  });
});

describe("parseEncKeys", () => {
  it("accepts versions mapped to 32-byte base64 keys", () => {
    expect(parseEncKeys(JSON.stringify({ current: 1, keys: { "1": base64Key(9) } }))).toEqual({ current: 1, keys: { "1": base64Key(9) } });
  });

  it.each([
    ["a key that is not 32 bytes", { current: 1, keys: { "1": base64Key(9, 16) } }],
    ["a key that is not base64", { current: 1, keys: { "1": "not base64!" } }],
    ["a missing current", { keys: { "1": base64Key(9) } }],
    ["a current with no key", { current: 2, keys: { "1": base64Key(9) } }],
    ["a non-integer version", { current: 1, keys: { "1": base64Key(9), x: base64Key(9) } }],
    ["no keys object", { current: 1 }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseEncKeys(JSON.stringify(value))).toThrow(expect.objectContaining({ code: "enc_keys_invalid", status: 500 }));
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseEncKeys("{")).toThrow(expect.objectContaining({ code: "enc_keys_invalid" }));
  });
});
