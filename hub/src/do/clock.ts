/** Milliseconds since the epoch. Tests swap in their own through env.__TEST_CLOCK. */
export interface Clock {
	now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
