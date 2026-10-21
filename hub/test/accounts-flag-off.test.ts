import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearTables } from "./db/helpers";
import { ENDPOINTS } from "./security/endpoints";

const ORIGIN = "https://hub.test";
const ACCOUNT_ENDPOINTS = ENDPOINTS.filter((e) => e.path.startsWith("/account/"));

const saved = { flag: env.ACCOUNTS_ENABLED, id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };

beforeEach(async () => {
  await clearTables();
  env.GOOGLE_CLIENT_ID = "google-client-id";
  env.GOOGLE_CLIENT_SECRET = "google-client-secret";
});

afterEach(() => {
  for (const [key, value] of [
    ["ACCOUNTS_ENABLED", saved.flag],
    ["GOOGLE_CLIENT_ID", saved.id],
    ["GOOGLE_CLIENT_SECRET", saved.secret],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(env, key);
    else env[key] = value;
  }
});

function request(method: string, path: string): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.50" };
  const init: RequestInit = { method, headers, redirect: "manual" };
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers.origin = ORIGIN;
    init.body = "email=a%40example.test&password=correct+horse+7&csrf=x&token=x";
  }
  return exports.default.fetch(`${ORIGIN}${path}`, init);
}

describe.each([
  ["unset", undefined],
  ["false", "false"],
  ["anything but true", "1"],
])("ACCOUNTS_ENABLED is %s", (_name, value) => {
  beforeEach(() => {
    if (value === undefined) Reflect.deleteProperty(env, "ACCOUNTS_ENABLED");
    else env.ACCOUNTS_ENABLED = value;
  });

  it("covers every account route in the endpoint list", () => {
    expect(ACCOUNT_ENDPOINTS).toHaveLength(13);
  });

  it.each(ACCOUNT_ENDPOINTS.map((e) => [`${e.method} ${e.path}`, e.method, e.path]))("answers the standard 404 for %s", async (_label, method, path) => {
    const res = await request(method as string, path as string);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("answers 404 for unknown paths under /account as well", async () => {
    expect((await request("GET", "/account/anything")).status).toBe(404);
    expect((await request("GET", "/account")).status).toBe(404);
  });

  it("writes nothing for an account request", async () => {
    for (const e of ACCOUNT_ENDPOINTS) await request(e.method, e.path);
    for (const table of ["users", "email_tokens", "login_attempts", "oauth_states", "ip_rate"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
      expect({ table, n: row?.n }).toEqual({ table, n: 0 });
    }
  });

  it("keeps the GitHub-only sign-in page on /app", async () => {
    const res = await request("GET", "/app");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/app/login"');
    expect(html).not.toContain("/account/");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<script");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("keeps GET /app/login on GitHub", async () => {
    const res = await request("GET", "/app/login");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
  });
});

describe("the flag shipped in wrangler.toml", () => {
  it("is off by default", () => {
    expect(saved.flag).not.toBe("true");
  });
});
