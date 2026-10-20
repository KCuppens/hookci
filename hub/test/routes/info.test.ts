import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";
import type { Env } from "../../src/env";

async function getInfo(overrides?: Partial<Env>): Promise<Response> {
  const url = "https://hub.test/v1/info";
  return overrides ? app.fetch(new Request(url), { ...env, ...overrides }) : exports.default.fetch(url);
}

describe("GET /v1/info", () => {
  it("answers without auth with exactly the documented keys and a 60 s cache", async () => {
    const res = await getInfo();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("max-age=60");
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(["github_app", "mode", "name", "protocol_versions", "slack", "version"]);
    expect(body).toEqual({
      name: "hookci-hub",
      version: env.HUB_VERSION,
      mode: "shared",
      protocol_versions: [1, 1],
      github_app: { slug: env.GITHUB_APP_SLUG },
      slack: { enabled: true },
    });
  });

  it("reports self_hosted only when HUB_MODE says so", async () => {
    for (const [hubMode, want] of [
      ["self_hosted", "self_hosted"],
      ["shared", "shared"],
      ["bogus", "shared"],
    ]) {
      const body = await (await getInfo({ HUB_MODE: hubMode })).json<{ mode: string }>();
      expect(body.mode, `HUB_MODE=${hubMode}`).toBe(want);
    }
  });

  it("reports slack disabled without a signing secret", async () => {
    const body = await (await getInfo({ SLACK_SIGNING_SECRET: "" })).json<{ slack: { enabled: boolean } }>();
    expect(body.slack).toEqual({ enabled: false });
  });
});
