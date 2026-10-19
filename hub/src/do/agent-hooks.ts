// Work that later tickets attach to the AgentDO's single alarm and to the
// agent going offline.

import type { AgentDO } from "./agent";

/** Runs on every alarm tick; resolves true while it still has pending work, which keeps the alarm scheduled. */
export type AlarmTask = (dob: AgentDO, now: number) => Promise<boolean>;
/** Runs once each time the agent goes from online to offline. */
export type OfflineHook = (dob: AgentDO) => Promise<void>;

const alarmTasks = new Set<AlarmTask>();
const offlineHooks = new Set<OfflineHook>();

/** Adds an alarm task; returns a function that removes it. */
export function registerAlarmTask(fn: AlarmTask): () => void {
	alarmTasks.add(fn);
	return () => alarmTasks.delete(fn);
}

/** Adds an offline hook; returns a function that removes it. */
export function registerOfflineHook(fn: OfflineHook): () => void {
	offlineHooks.add(fn);
	return () => offlineHooks.delete(fn);
}

export function registeredAlarmTasks(): Iterable<AlarmTask> {
	return alarmTasks;
}

export function registeredOfflineHooks(): Iterable<OfflineHook> {
	return offlineHooks;
}
