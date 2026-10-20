import { describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { ENDPOINTS } from "./endpoints";

describe("ENDPOINTS", () => {
  it("lists every route the app serves, once each, and only those", () => {
    // Middleware registers as ALL; every handler has a concrete method.
    const served = [...new Set(app.routes.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`))].sort();
    expect(ENDPOINTS.map((e) => `${e.method} ${e.path}`).sort()).toEqual(served);
  });
});
