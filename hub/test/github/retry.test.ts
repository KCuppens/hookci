import { describe, expect, it } from "vitest";
import { GitHubRateLimitedError, withRetry } from "../../src/github/retry";

const NOW = 1_700_000_000_000;

/** fn answering with the given responses in order, counting its calls. */
function answers(...responses: Response[]) {
  const fn = async () => {
    fn.calls++;
    const res = responses.shift();
    if (!res) throw new Error("no more responses");
    return res;
  };
  fn.calls = 0;
  return fn;
}

function recordSleeps() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

describe("withRetry", () => {
  it("waits retry-after seconds plus jitter on 429, then returns the success", async () => {
    const fn = answers(new Response("slow down", { status: 429, headers: { "retry-after": "2" } }), Response.json({ ok: 1 }));
    const { slept, sleep } = recordSleeps();

    const res = await withRetry(fn, { sleep, now: () => NOW });

    expect(res.status).toBe(200);
    expect(fn.calls).toBe(2);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(2000);
    expect(slept[0]).toBeLessThanOrEqual(2500);
  });

  it("honours retry-after on a 403 secondary rate limit", async () => {
    const fn = answers(new Response("", { status: 403, headers: { "retry-after": "1" } }), new Response("{}"));
    const { slept, sleep } = recordSleeps();

    await withRetry(fn, { sleep, now: () => NOW, random: () => 0 });

    expect(slept).toEqual([1000]);
  });

  it("throws github_rate_limited with retryAt when the primary limit resets 120 s ahead", async () => {
    const reset = NOW / 1000 + 120;
    const fn = answers(
      new Response("rate limited", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      }),
    );
    const { slept, sleep } = recordSleeps();

    const err = await withRetry(fn, { sleep, now: () => NOW }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitHubRateLimitedError);
    expect(err).toMatchObject({ code: "github_rate_limited", status: 503, retryAt: reset * 1000 });
    expect(slept).toEqual([]);
    expect(fn.calls).toBe(1);
  });

  it("throws github_unavailable after four 502s, backing off 1 s, 2 s, 4 s with full jitter", async () => {
    const fn = answers(...Array.from({ length: 4 }, () => new Response("bad gateway", { status: 502 })));
    const { slept, sleep } = recordSleeps();

    await expect(withRetry(fn, { sleep, random: () => 0.999 })).rejects.toMatchObject({
      code: "github_unavailable",
      status: 503,
    });

    expect(fn.calls).toBe(4);
    expect(slept).toHaveLength(3);
    expect(slept[0]).toBeLessThan(1000);
    expect(slept[1]).toBeLessThan(2000);
    expect(slept[2]).toBeLessThan(4000);
    expect(slept[2]).toBeGreaterThan(3990);
  });

  it("returns other statuses without retrying", async () => {
    const fn = answers(new Response("missing", { status: 404 }));
    const { slept, sleep } = recordSleeps();

    const res = await withRetry(fn, { sleep });

    expect(res.status).toBe(404);
    expect(fn.calls).toBe(1);
    expect(slept).toEqual([]);
  });
});
