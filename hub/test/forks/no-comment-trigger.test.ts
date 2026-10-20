/// <reference types="vite/client" />
import { expect, it } from "vitest";

const sources: Record<string, string> = import.meta.glob<string>("../../src/**/*.ts", { query: "?raw", import: "default", eager: true });

it("no hub source registers issue_comment or ok-to-test fork triggers", () => {
  expect(Object.keys(sources).length).toBeGreaterThan(50);
  const offenders = Object.entries(sources).flatMap(([path, text]) => (/issue_comment|ok-to-test/.test(text) ? [path] : []));
  expect(offenders).toEqual([]);
});
