import type { Clock } from "../src/do/clock";

interface TestClock extends Clock {
  advance(ms: number): void;
  reset(): void;
}

let offset = 0;

/** Wall clock shifted by advance(); setup.ts installs it as env.__TEST_CLOCK and resets it before each test. */
export const testClock: TestClock = {
  now: () => Date.now() + offset,
  advance(ms) {
    offset += ms;
  },
  reset() {
    offset = 0;
  },
};
