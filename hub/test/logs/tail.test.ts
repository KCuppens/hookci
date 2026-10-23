import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getLogTail } from "../../src/logs/tail";
import { clearTables } from "../db/helpers";
import { gzip, numberedLines, seedRun } from "./helpers";

const INSTALLATION = 41;
const RUN = "run_tail_1";
const KEY = `logs/${INSTALLATION}/${RUN}/test.log.gz`;

function lines(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`);
}

beforeEach(async () => {
  await clearTables();
  await env.LOGS.delete(KEY);
  await seedRun(INSTALLATION, 4100, RUN, "agt_tail");
});

describe("getLogTail", () => {
  it("returns lines 61 to 100 of a 100-line log for n=40", async () => {
    await env.LOGS.put(KEY, await gzip(numberedLines(100)));
    expect(await getLogTail(env, RUN, "test", 40)).toEqual(lines(61, 100));
  });

  it("returns the whole log when it is shorter than n, including a last line without a newline", async () => {
    await env.LOGS.put(KEY, await gzip("line 1\nline 2\nline 3"));
    expect(await getLogTail(env, RUN, "test", 40)).toEqual(lines(1, 3));
  });

  it("keeps the order across a log many times longer than n", async () => {
    await env.LOGS.put(KEY, await gzip(numberedLines(20_000)));
    expect(await getLogTail(env, RUN, "test", 40)).toEqual(lines(19_961, 20_000));
  });

  it("shows what a terminal would of progress redrawn with carriage returns, keeping \\r\\n line ends", async () => {
    await env.LOGS.put(KEY, await gzip("line 1\r\nfetch 10%\rfetch 50%\rfetch 100%\nline 3\rline 4\r"));
    expect(await getLogTail(env, RUN, "test", 40)).toEqual(["line 1", "fetch 100%", "line 4"]);
  });

  it("keeps only the last 64 KiB of a line that never ends", async () => {
    const long = `${"a".repeat(1_000_000)}${"b".repeat(65_536)}`;
    await env.LOGS.put(KEY, await gzip(`line 1\n${long}\nline 3\n${long}`));
    expect(await getLogTail(env, RUN, "test", 40)).toEqual(["line 1", "b".repeat(65_536), "line 3", "b".repeat(65_536)]);
  });

  it("drops the agent's timestamp prefix and leaves unstamped lines alone", async () => {
    await env.LOGS.put(KEY, await gzip("old\n2026-05-05T14:32:01.123Z line 2\n2026-05-05T14:32:01.124Z \n2026-05-05T14:32:01.125Z line 4"));
    expect(await getLogTail(env, RUN, "test", 40)).toEqual(["old", "line 2", "", "line 4"]);
  });

  it("returns null when the job has no stored log", async () => {
    expect(await getLogTail(env, RUN, "test", 40)).toBeNull();
  });

  it("returns null when the run does not exist", async () => {
    await env.LOGS.put(KEY, await gzip(numberedLines(3)));
    expect(await getLogTail(env, "run_missing", "test", 40)).toBeNull();
  });
});
