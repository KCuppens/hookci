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

/**
 * Claims the one admin DM of the agent's current offline episode in its
 * AgentDO storage (meta offline_dm_sent_at): true the first time, false until
 * clearOfflineDm, which hello calls when the agent is back.
 */
export function claimOfflineDm(storage: DurableObjectStorage, now: number): boolean {
	return (
		storage.sql
			.exec("INSERT INTO meta (key, value) VALUES ('offline_dm_sent_at', ?) ON CONFLICT (key) DO NOTHING RETURNING key", String(now))
			.toArray().length > 0
	);
}

/** Ends the offline episode's DM claim: the agent is back, or the DM failed to go out. */
export function clearOfflineDm(storage: DurableObjectStorage): void {
	storage.sql.exec("DELETE FROM meta WHERE key = 'offline_dm_sent_at'");
}
