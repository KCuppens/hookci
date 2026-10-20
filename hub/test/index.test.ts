import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("zeroci-hub", () => {
  it("responds to GET /healthz with 200 ok", async () => {
    const res = await SELF.fetch("https://example.com/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("responds to non-GET /healthz with 404", async () => {
    const res = await SELF.fetch("https://example.com/healthz", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("responds to unknown routes with 404", async () => {
    const res = await SELF.fetch("https://example.com/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });
});
