import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { QUOTAS } from "../../src/quotas";

async function html(path: string): Promise<string> {
  const res = await exports.default.fetch(`https://hub.test${path}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  return res.text();
}

describe("public pages", () => {
  it("GET /privacy covers collection, storage, retention, deletion, export, subprocessors and contact", async () => {
    const body = await html("/privacy");
    for (const heading of ["Data we collect", "Where data is stored", "Retention", "Deletion", "Export", "Subprocessors", "Contact"]) {
      expect(body).toContain(`<h2>${heading}</h2>`);
    }
    expect(body).toContain(`kept for ${QUOTAS.retentionDays} days`);
    expect(body).toContain("/hookci delete-my-data");
    expect(body).toContain("/hookci export");
    expect(body).toContain("never sent to the hub");
  });

  it("GET /terms has the terms headings", async () => {
    const body = await html("/terms");
    for (const heading of ["Use of the service", "Acceptable use", "No warranty", "Termination", "Contact"]) {
      expect(body).toContain(`<h2>${heading}</h2>`);
    }
  });

  it("GET /support has the help, email and security headings", async () => {
    const body = await html("/support");
    for (const heading of ["Getting help", "Email", "Security issues"]) expect(body).toContain(`<h2>${heading}</h2>`);
  });
});

describe("GET /.well-known/security.txt", () => {
  it("serves RFC 9116 fields", async () => {
    const res = await exports.default.fetch("https://hub.test/.well-known/security.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const lines = (await res.text()).split("\n");
    expect(lines).toContain("Contact: mailto:security@webuno.io");
    expect(lines).toContain(`Expires: ${env.SECURITY_TXT_EXPIRES}`);
    expect(Number.isNaN(Date.parse(env.SECURITY_TXT_EXPIRES))).toBe(false);
    expect(lines).toContain("Policy: https://github.com/KCuppens/hookci/blob/main/SECURITY.md");
    expect(lines).toContain("Preferred-Languages: en");
  });
});
