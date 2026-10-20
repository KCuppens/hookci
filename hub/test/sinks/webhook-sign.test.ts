import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import docs from "../../../docs/webhooks.md?raw";
import { generateWebhookSecret, signWebhook } from "../../src/sinks/webhook";

// The Node snippet from docs/webhooks.md, with the clock passed in.
function verifyZeroCI(secret: string, timestamp: string, body: string, signature: string, nowSec: number): boolean {
  if (Math.abs(nowSec - Number(timestamp)) > 300) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

describe("signWebhook", () => {
  it("matches HMAC-SHA256 over `${timestamp}.${body}` from Node crypto", async () => {
    const vector = `sha256=${createHmac("sha256", "s").update("1700000000.{}").digest("hex")}`;
    expect(await signWebhook("s", 1700000000, "{}")).toBe(vector);
    expect(vector).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("is accepted by the verification snippet in docs/webhooks.md", async () => {
    expect(docs).toContain('const expected = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");');
    expect(docs).toContain("return a.length === b.length && timingSafeEqual(a, b);");
    expect(docs).toContain("Math.abs(Date.now() / 1000 - Number(timestamp)) > 300");

    const body = JSON.stringify({ v: 1, type: "run.updated" });
    const sig = await signWebhook("zcwh_secret", 1700000000, body);
    expect(verifyZeroCI("zcwh_secret", "1700000000", body, sig, 1700000100)).toBe(true);
    expect(verifyZeroCI("zcwh_other", "1700000000", body, sig, 1700000100)).toBe(false);
    expect(verifyZeroCI("zcwh_secret", "1700000000", `${body} `, sig, 1700000100)).toBe(false);
    expect(verifyZeroCI("zcwh_secret", "1700000000", body, sig, 1700000301)).toBe(false);
  });
});

describe("generateWebhookSecret", () => {
  it("is zcwh_ and 64 lowercase hex characters, fresh each time", () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^zcwh_[0-9a-f]{64}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});
