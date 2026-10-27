import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Source, THEME_SCRIPT } from "../../src/pages/shell";

describe("Light/Dark theme", () => {
  it("pins the theme script in a page's CSP and renders the toggle", async () => {
    const res = await exports.default.fetch("https://hub.test/status");
    const html = await res.text();
    expect(res.headers.get("content-security-policy")).toContain(await sha256Source(THEME_SCRIPT));
    expect(html).toContain(`<script>${THEME_SCRIPT}</script>`);
    expect(html).toContain("data-theme-toggle");
  });

  it("serves the same script to the log viewer", async () => {
    const res = await exports.default.fetch("https://hub.test/logs/theme.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(THEME_SCRIPT);
  });
});
