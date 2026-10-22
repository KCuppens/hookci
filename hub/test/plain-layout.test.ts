import { describe, expect, it } from "vitest";
import { PLAIN_CSS, PLAIN_CSS_HASH, page } from "../src/pages/layout";

describe("plain layout", () => {
  it("pins its one stylesheet by SHA-256 in the CSP", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PLAIN_CSS));
    const hash = `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
    expect(PLAIN_CSS_HASH).toBe(hash);
    const res = page("Title", "<p>Body</p>");
    expect(res.headers.get("content-security-policy")).toContain(`style-src '${hash}'`);
    expect(await res.text()).toContain(`<style>${PLAIN_CSS}</style>`);
  });

  it("sets the mobile viewport with the safe-area extension", async () => {
    const html = await page("Title", "<p>Body</p>").text();
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
  });
});
