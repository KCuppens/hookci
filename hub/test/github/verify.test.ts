import { describe, expect, it } from "vitest";
import { verifyGithubSignature } from "../../src/github/verify";

// GitHub's documented example for X-Hub-Signature-256.
const SECRET = "It's a Secret to Everybody";
const BODY = new TextEncoder().encode("Hello, World!").buffer as ArrayBuffer;
const SIGNATURE = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

describe("verifyGithubSignature", () => {
  it("accepts GitHub's golden vector", async () => {
    expect(await verifyGithubSignature(BODY, SIGNATURE, [SECRET])).toBe(true);
  });

  it("rejects a signature made with another secret", async () => {
    expect(await verifyGithubSignature(BODY, SIGNATURE, ["not the secret"])).toBe(false);
  });

  it("accepts the previous secret when the current one does not match", async () => {
    expect(await verifyGithubSignature(BODY, SIGNATURE, ["rotated secret", SECRET])).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const tampered = new TextEncoder().encode("Hello, World?").buffer as ArrayBuffer;
    expect(await verifyGithubSignature(tampered, SIGNATURE, [SECRET])).toBe(false);
  });

  it("rejects a missing header", async () => {
    expect(await verifyGithubSignature(BODY, null, [SECRET])).toBe(false);
  });

  it("rejects a sha1 header even with the right digest bytes", async () => {
    expect(await verifyGithubSignature(BODY, SIGNATURE.replace("sha256=", "sha1="), [SECRET])).toBe(false);
  });

  it("rejects everything when no secret is configured", async () => {
    expect(await verifyGithubSignature(BODY, SIGNATURE, [])).toBe(false);
  });
});
