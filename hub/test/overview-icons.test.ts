import { describe, expect, it } from "vitest";
import { TRACED_ICONS } from "../src/pages/overview-icons";

describe("overview traced icons", () => {
  it("are inline path groups with no style attribute or script", () => {
    for (const [name, svg] of Object.entries(TRACED_ICONS)) {
      expect(svg, name).toMatch(/^<g [^>]*>(<path [^>]*d="[^"]+"\/>)+<\/g>$/);
      expect(svg, name).not.toContain("style=");
    }
  });

  it("covers every glyph the page references", () => {
    for (const name of ["bang", "g-tick", "g-x", "chk", "fork", "ghm", "arrow", "cal", "chevd", "db", "tri", "pass", "clk", "dbb"]) {
      expect(TRACED_ICONS[name], name).toBeTruthy();
    }
  });
});
