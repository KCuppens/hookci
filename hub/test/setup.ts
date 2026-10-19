import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { testClock } from "./clock";
import { resetFakes } from "./fakes/http";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

env.__TEST_CLOCK = testClock;

beforeEach(() => {
  resetFakes();
  testClock.reset();
});
