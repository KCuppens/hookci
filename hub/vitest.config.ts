import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// Fixed values for the secrets typed in src/env.ts, so tests never need real ones.
const testKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const testSecrets = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "test-github-app-private-key",
  GITHUB_CLIENT_ID: "test-github-client-id",
  GITHUB_CLIENT_SECRET: "test-github-client-secret",
  GITHUB_WEBHOOK_SECRET: "test-github-webhook-secret",
  SLACK_CLIENT_ID: "test-slack-client-id",
  SLACK_CLIENT_SECRET: "test-slack-client-secret",
  SLACK_SIGNING_SECRET: "test-slack-signing-secret",
  TOKEN_ENC_KEYS: JSON.stringify({ current: 1, keys: { "1": testKey } }),
  STATE_SIGNING_KEY: "test-state-signing-key",
  LOG_SIGNING_KEY: "test-log-signing-key",
};

// Miniflare keeps D1 and Durable Object storage in a directory under
// os.tmpdir() and commits every D1 statement, reads included, with an fsync.
// On a disk that costs ~10 ms a statement and the run-budget load test took
// over 90 s; in RAM it is ~0.5 ms. os.tmpdir() reads TMPDIR when Miniflare
// starts, after this file is loaded.
if (existsSync("/dev/shm")) process.env.TMPDIR = "/dev/shm";
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          ...testSecrets,
          // wrangler.toml leaves them empty until the first release.
          LATEST_AGENT_VERSION: "v0.3.0",
          MIN_AGENT_VERSION: "v0.1.0",
          TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    // test/cli runs under vitest.cli.config.ts in the node environment.
    exclude: [...configDefaults.exclude, "test/cli/**"],
  },
});
