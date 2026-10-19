import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

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
  LOG_SIGNING_KEYS: JSON.stringify({ "1": testKey }),
};

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
  },
});
