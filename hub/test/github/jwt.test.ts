import { describe, expect, it, vi } from "vitest";
import { appJwt } from "../../src/github/jwt";
import { generateAppKey } from "./helpers";

function decodeSegment(segment: string): Uint8Array {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

describe("appJwt", () => {
  it("signs RS256 claims that verify with the app's public key", async () => {
    const { pem, publicKey } = await generateAppKey();
    const now = 1_700_000_000_123;

    const jwt = await appJwt("4242", pem, now);

    const [header = "", claims = "", signature = ""] = jwt.split(".");
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodeSegment(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(verified).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(decodeSegment(header)))).toEqual({ alg: "RS256", typ: "JWT" });
    const body = JSON.parse(new TextDecoder().decode(decodeSegment(claims)));
    expect(body).toEqual({ iss: "4242", iat: 1_700_000_000 - 60, exp: 1_700_000_000 - 60 + 540 });
    expect(body.exp - body.iat).toBe(540);
  });

  it("rejects a PKCS#1 key with the openssl conversion hint", async () => {
    const { pem } = await generateAppKey();
    const pkcs1 = pem.replace(/PRIVATE KEY-----/g, "RSA PRIVATE KEY-----");

    await expect(appJwt("1", pkcs1)).rejects.toMatchObject({
      code: "github_key_format",
      status: 500,
      message: "convert key with openssl pkcs8 -topk8 -nocrypt",
    });
  });

  it("rejects a value that is not a PEM key", async () => {
    await expect(appJwt("1", "test-github-app-private-key")).rejects.toMatchObject({
      code: "github_key_format",
      status: 500,
    });
  });

  it("imports the key once and hands out the same JWT for 5 minutes, then signs a fresh one", async () => {
    const { pem } = await generateAppKey();
    const imports = vi.spyOn(crypto.subtle, "importKey");
    const now = 1_700_000_000_000;

    const first = await appJwt("7", pem, now);
    expect(await appJwt("7", pem, now + 5 * 60_000)).toBe(first);
    const fresh = await appJwt("7", pem, now + 5 * 60_000 + 1);
    expect(fresh).not.toBe(first);
    expect(JSON.parse(new TextDecoder().decode(decodeSegment(fresh.split(".")[1] ?? "")))).toMatchObject({ iat: 1_700_000_300 - 60 });
    expect(await appJwt("8", pem, now)).not.toBe(first);
    expect(imports).toHaveBeenCalledTimes(1);
    imports.mockRestore();
  });
});
