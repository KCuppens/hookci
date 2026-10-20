import { defineConfig } from "vitest/config";

// The zeroci-hub CLI runs on Node, not in the Workers runtime, so its tests
// use the plain node environment instead of the workers pool.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/cli/**/*.test.ts"],
  },
});
