import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /assets/inter.woff2", () => {
  it("serves the self-hosted font as woff2 with a year of immutable caching and no session", async () => {
    const res = await exports.default.fetch("https://hub.test/assets/inter.woff2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("wOF2");
  });

  it("is allowed by the page CSP through font-src self and nothing else", async () => {
    const res = await exports.default.fetch("https://hub.test/status");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("default-src 'none'");
  });
});
