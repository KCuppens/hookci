/// <reference types="vite/client" />
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import security from "../../SECURITY.md?raw";
import support from "../../docs/support.md?raw";
import { legalModule } from "../scripts/gen-legal.mjs";
import { LEGAL_DOCS } from "../src/legal/content";
import contentTs from "../src/legal/content.ts?raw";
import { QUOTAS } from "../src/quotas";
import { handleWellKnown, securityTxt } from "../src/routes/well-known";
import { testClock } from "./clock";

const DAY_MS = 24 * 60 * 60 * 1000;
const DRAFT = "DRAFT: requires human legal review before publication\n";

describe("GET /.well-known/security.txt", () => {
  it("serves Contact, Policy, Canonical and an Expires within 366 days as text/plain", async () => {
    const res = await exports.default.fetch("https://hub.test/.well-known/security.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const lines = (await res.text()).split("\n");
    expect(lines).toContain(`Contact: ${env.SECURITY_CONTACT}`);
    expect(lines).toContain(`Policy: ${env.HUB_ORIGIN}/security`);
    expect(lines).toContain("Preferred-Languages: en");
    expect(lines).toContain(`Canonical: ${env.HUB_ORIGIN}/.well-known/security.txt`);
    const expires = Date.parse(lines.find((line) => line.startsWith("Expires: "))?.slice("Expires: ".length) ?? "");
    const now = testClock.now();
    expect(expires).toBeGreaterThan(now);
    expect(expires).toBeLessThanOrEqual(now + 366 * DAY_MS);
  });

  it("sets Expires a year past now and falls back to GitHub advisories without SECURITY_CONTACT", () => {
    const body = securityTxt({ ...env, SECURITY_CONTACT: "" }, new Date("2030-01-01T00:00:00Z"));
    expect(body).toContain("Expires: 2031-01-01T00:00:00Z\n");
    expect(body).toContain("Contact: https://github.com/KCuppens/hookci/security/advisories/new\n");
  });
});

describe("legal pages", () => {
  it.each([
    ["/privacy", "privacy"],
    ["/terms", "terms"],
    ["/support", "support"],
    ["/security", "security"],
  ] as const)("GET %s serves the document as locked down HTML", async (path, doc) => {
    const res = await exports.default.fetch(`https://hub.test${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    const heading = /^# (.+)$/m.exec(LEGAL_DOCS[doc])?.[1];
    expect(heading).toBeTruthy();
    expect(await res.text()).toContain(`<h1>${heading}</h1>`);
  });

  it("handleWellKnown answers null for other paths and methods", () => {
    expect(handleWellKnown(new Request("https://hub.test/nope"), env)).toBeNull();
    expect(handleWellKnown(new Request("https://hub.test/privacy", { method: "POST" }), env)).toBeNull();
  });

  it("marks privacy and terms as drafts; privacy lists the subprocessors and log retention", () => {
    expect(LEGAL_DOCS.privacy.startsWith(DRAFT)).toBe(true);
    expect(LEGAL_DOCS.terms.startsWith(DRAFT)).toBe(true);
    for (const row of ["| Cloudflare |", "| bugwatch |", "| Transactional email provider |"]) expect(LEGAL_DOCS.privacy).toContain(row);
    expect(LEGAL_DOCS.privacy).toContain(`| Job logs | ${QUOTAS.retentionDays} days`);
  });

  it("has no em or en dashes in the documents", () => {
    for (const markdown of Object.values(LEGAL_DOCS)) expect(markdown).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("generated legal content", () => {
  it("matches a fresh scripts/gen-legal.mjs run over the documents", () => {
    const legal = import.meta.glob<string>("../../docs/legal/*.md", { query: "?raw", import: "default", eager: true });
    expect(Object.keys(legal).length).toBeGreaterThan(0);
    expect(legalModule({ ...legal, "docs/support.md": support, "SECURITY.md": security })).toBe(contentTs);
  });
});
