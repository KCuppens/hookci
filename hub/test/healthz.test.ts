import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleError } from "../src/app";
import type { Env } from "../src/env";
import { HubError } from "../src/errors";

// An app with the Worker's error handler and routes that throw.
function throwingApp(err: Error) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleError);
  app.get("/boom", () => {
    throw err;
  });
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /healthz", () => {
  it("returns 200 JSON with the hub version", async () => {
    const res = await exports.default.fetch("https://hub.test/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ ok: true, version: env.HUB_VERSION });
    expect(env.HUB_VERSION).not.toBe("");
  });
});

describe("unknown routes", () => {
  it("return 404 JSON", async () => {
    const res = await exports.default.fetch("https://hub.test/v1/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("error handling", () => {
  it("maps HubError to its status and code without reporting it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await throwingApp(new HubError("auth_failed", 401, "bad bearer")).request("/boom", {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_failed" });
    expect(logged).not.toHaveBeenCalled();
  });

  it("defaults HubError status to 400", async () => {
    const res = await throwingApp(new HubError("bad_request")).request("/boom", {}, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("maps an unknown error to 500 and reports it once, redacted", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await throwingApp(new Error("lookup failed for ghs_SecretToken123")).request("/boom", {}, env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });

    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).not.toContain("SecretToken123");
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      method: "GET",
      path: "/boom",
      error: { name: "Error", message: "lookup failed for ghs_[redacted]" },
    });
  });
});
