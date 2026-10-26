import { describe, expect, it } from "vitest";
import { PILL_ICONS, runPill } from "../src/pages/pills";
import { RUNS_TRACED_ICONS } from "../src/pages/runs-icons";

const STATES = ["pending", "queued", "gated", "running", "rolling_back", "success", "failed", "cancelled", "interrupted", "verifying", "no_such_state"];

describe("runs traced icons", () => {
  it("are inline filled paths with no style attribute or script", () => {
    for (const [name, svg] of Object.entries(RUNS_TRACED_ICONS)) {
      expect(svg, name).toMatch(/^<path [^>]*d="[^"]+"\/>$/);
      expect(svg, name).not.toContain("style=");
    }
  });

  it("cover every glyph the filter bar and banner reference", () => {
    for (const name of ["monitor", "branch", "circle", "stack", "user", "bolt", "search", "chevd", "x"]) {
      expect(RUNS_TRACED_ICONS[name], name).toBeTruthy();
    }
  });
});

describe("state pills", () => {
  it("reference an icon that exists for every state", () => {
    for (const state of STATES) {
      const html = runPill(state, "/1/runs/r");
      const id = /<use href="#i-([^"]+)"/.exec(html)?.[1] ?? "";
      expect(id, state).toBeTruthy();
      expect(PILL_ICONS[id], `${state} -> ${id}`).toBeTruthy();
    }
  });
});
