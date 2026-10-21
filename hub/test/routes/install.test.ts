import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /install", () => {
  it("serves the installer with the hub origin filled in", async () => {
    const res = await exports.default.fetch("https://hub.test/install");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = await res.text();
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);
    expect(body).toContain(`HUB_ORIGIN="${env.HUB_ORIGIN}"`);
    expect(body).toContain(`curl -fsSL ${env.HUB_ORIGIN}/install | sh`);
    expect(body).not.toMatch(/__[A-Z_]+__/);
  });
});
