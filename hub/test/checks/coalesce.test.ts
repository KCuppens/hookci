import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type CheckUpdate, CheckUpdateCoalescer, FLUSH_INTERVAL_MS } from "../../src/checks/coalesce";
import { GitHubRateLimitedError } from "../../src/github/retry";
import type { UpdateCheckRunBody } from "../../src/github/types";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { seedAgent } from "../do/agent-socket";

const TARGET = { installationId: 42, repoId: 1001, repo: "acme/widgets", headSha: "1".repeat(40), name: "hookci/test" };

function update(title: string, status: UpdateCheckRunBody["status"] = "in_progress"): CheckUpdate {
  return { ...TARGET, body: { status, output: { title, summary: title } } };
}

/** Runs fn in a fresh AgentDO with a coalescer whose sends land in sent (or throw what fail returns). */
async function withCoalescer(
  fn: (c: CheckUpdateCoalescer, sent: string[], storage: DurableObjectStorage) => Promise<void>,
  fail: (u: CheckUpdate) => Error | undefined = () => undefined,
): Promise<void> {
  const agent = await seedAgent(42);
  await runInDurableObject(agent.stub, async (dob) => {
    const sent: string[] = [];
    const storage = dob.state.storage;
    const coalescer = new CheckUpdateCoalescer({ storage, now: () => testClock.now() }, async (u) => {
      const err = fail(u);
      if (err) throw err;
      sent.push(u.body.output?.title ?? "");
    });
    await fn(coalescer, sent, storage);
  });
}

describe("CheckUpdateCoalescer", () => {
  beforeEach(clearTables);

  it("sends the first update at once and only the latest of the rest after the interval", async () => {
    await withCoalescer(async (c, sent, storage) => {
      for (let i = 0; i < 20; i++) {
        await c.push(update(`step ${i}`));
        testClock.advance(50);
      }
      expect(sent).toEqual(["step 0"]);
      expect(await storage.getAlarm()).toBeLessThanOrEqual(testClock.now() + FLUSH_INTERVAL_MS);

      expect(await c.flushDue()).toBe(true);
      expect(sent).toEqual(["step 0"]);

      testClock.advance(FLUSH_INTERVAL_MS);
      expect(await c.flushDue()).toBe(false);
      expect(sent).toEqual(["step 0", "step 19"]);
    });
  });

  it("sends a completed update at once and drops the pending one", async () => {
    await withCoalescer(async (c, sent) => {
      await c.push(update("running"));
      await c.push(update("compile"));
      await c.push(update("Passed", "completed"));
      expect(sent).toEqual(["running", "Passed"]);
      testClock.advance(FLUSH_INTERVAL_MS);
      expect(await c.flushDue()).toBe(false);
      expect(sent).toEqual(["running", "Passed"]);
    });
  });

  it("sends an update at once after a quiet interval", async () => {
    await withCoalescer(async (c, sent) => {
      await c.push(update("a"));
      testClock.advance(FLUSH_INTERVAL_MS);
      await c.push(update("b"));
      expect(sent).toEqual(["a", "b"]);
    });
  });

  it("keeps a rate-limited update until GitHub's retry time", async () => {
    let retryAt = 0;
    let limited = true;
    await withCoalescer(
      async (c, sent, storage) => {
        retryAt = testClock.now() + 60_000;
        await c.push(update("Passed", "completed"));
        expect(sent).toEqual([]);
        expect(await storage.getAlarm()).toBeLessThanOrEqual(retryAt);

        testClock.advance(FLUSH_INTERVAL_MS);
        expect(await c.flushDue()).toBe(true);
        expect(sent).toEqual([]);

        limited = false;
        testClock.advance(60_000);
        expect(await c.flushDue()).toBe(false);
        expect(sent).toEqual(["Passed"]);
      },
      () => (limited ? new GitHubRateLimitedError(retryAt) : undefined),
    );
  });

  it("caps annotations per check run and counts the excess", async () => {
    await withCoalescer(async (c) => {
      expect(c.reserveAnnotations(TARGET, 300, 500)).toBe(300);
      expect(c.reserveAnnotations(TARGET, 300, 500)).toBe(200);
      expect(c.reserveAnnotations(TARGET, 10, 500)).toBe(0);
      expect(c.annotationsSeen(TARGET)).toBe(610);
      expect(c.reserveAnnotations({ ...TARGET, name: "hookci/lint" }, 10, 500)).toBe(10);
    });
  });
});
