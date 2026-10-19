// Holds back check run updates so each check run gets at most one in-progress
// update per FLUSH_INTERVAL_MS: the first goes out at once, later ones wait in
// the AgentDO's SQLite (latest wins) until the alarm flushes them. Completed
// updates always go out at once. SQLite and the alarm, not memory and timers,
// so a hibernating DO neither loses an update nor is kept awake.

import { GitHubRateLimitedError } from "../github/retry";
import type { UpdateCheckRunBody } from "../github/types";
import { reportError } from "../observability";
import type { SinkHost } from "../sinks";

export const FLUSH_INTERVAL_MS = 2000;
/** Rows with nothing pending are forgotten after a day. */
const FORGET_AFTER_MS = 86_400_000;

/** One named check run of one commit. */
export interface CheckTarget {
	installationId: number;
	repoId: number;
	repo: string;
	headSha: string;
	name: string;
}

export interface CheckUpdate extends CheckTarget {
	body: UpdateCheckRunBody;
}

export type SendUpdate = (update: CheckUpdate) => Promise<void>;

type StateRow = {
	key: string;
	sent_at: number;
	pending: string | null;
	due_at: number | null;
	annotations: number;
};

/** DO migration step: one row per check run the coalescer has seen. */
export function createCheckStateTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE check_state (key TEXT PRIMARY KEY, sent_at INTEGER NOT NULL DEFAULT 0, pending TEXT, due_at INTEGER,
		annotations INTEGER NOT NULL DEFAULT 0, touched_at INTEGER NOT NULL)`,
	);
}

const keyOf = (t: Pick<CheckTarget, "repoId" | "headSha" | "name">) => `${t.repoId}:${t.headSha}:${t.name}`;

export class CheckUpdateCoalescer {
	constructor(
		private readonly host: SinkHost,
		private readonly send: SendUpdate,
	) {}

	/** Sends update now, or keeps it as the check run's pending update and schedules the alarm. */
	async push(update: CheckUpdate): Promise<void> {
		const now = this.host.now();
		const key = keyOf(update);
		const row = this.sql.exec<StateRow>("SELECT * FROM check_state WHERE key = ?", key).toArray()[0];
		const sentAt = row?.sent_at ?? 0;
		if (update.body.status === "completed" || (row?.pending == null && now - sentAt >= FLUSH_INTERVAL_MS)) {
			await this.deliver(key, update, now);
			return;
		}
		const due = row?.due_at ?? Math.max(now, sentAt + FLUSH_INTERVAL_MS);
		this.keep(key, update, due, now, true);
		await this.schedule(due);
	}

	/** Sends every pending update that is due; resolves true while some stay pending. */
	async flushDue(): Promise<boolean> {
		const now = this.host.now();
		const due = this.sql.exec<StateRow>("SELECT * FROM check_state WHERE pending IS NOT NULL AND due_at <= ? ORDER BY due_at", now).toArray();
		for (const row of due) {
			if (row.pending === null) continue;
			const update: CheckUpdate = JSON.parse(row.pending);
			try {
				await this.deliver(row.key, update, now);
			} catch (err) {
				reportError(err, { installation_id: update.installationId, repo_id: update.repoId, check: update.name, op: "check_flush" });
			}
		}
		this.sql.exec("DELETE FROM check_state WHERE pending IS NULL AND touched_at < ?", now - FORGET_AFTER_MS);
		const next = this.sql.exec<{ due_at: number | null }>("SELECT min(due_at) AS due_at FROM check_state WHERE pending IS NOT NULL").one().due_at;
		if (next === null) return false;
		await this.schedule(next);
		return true;
	}

	/**
	 * Counts wanted more annotations for the check run and returns how many of
	 * them fit under cap; the count keeps what did not fit, for annotationsSeen.
	 */
	reserveAnnotations(target: CheckTarget, wanted: number, cap: number): number {
		const key = keyOf(target);
		const seen = this.annotationsSeen(target);
		this.sql.exec(
			`INSERT INTO check_state (key, annotations, touched_at) VALUES (?, ?, ?)
			ON CONFLICT (key) DO UPDATE SET annotations = excluded.annotations, touched_at = excluded.touched_at`,
			key,
			seen + wanted,
			this.host.now(),
		);
		return Math.max(0, Math.min(wanted, cap - seen));
	}

	/** How many annotations the check run was sent, including those over the cap. */
	annotationsSeen(target: CheckTarget): number {
		return this.sql.exec<StateRow>("SELECT * FROM check_state WHERE key = ?", keyOf(target)).toArray()[0]?.annotations ?? 0;
	}

	private get sql(): SqlStorage {
		return this.host.storage.sql;
	}

	/**
	 * Marks the check run sent before sending, so updates pushed meanwhile wait
	 * their turn. A rate limit keeps the update pending until GitHub's retry
	 * time, unless a newer one arrived meanwhile.
	 */
	private async deliver(key: string, update: CheckUpdate, now: number): Promise<void> {
		this.sql.exec(
			`INSERT INTO check_state (key, sent_at, pending, due_at, touched_at) VALUES (?, ?, NULL, NULL, ?)
			ON CONFLICT (key) DO UPDATE SET sent_at = excluded.sent_at, pending = NULL, due_at = NULL, touched_at = excluded.touched_at`,
			key,
			now,
			now,
		);
		try {
			await this.send(update);
		} catch (err) {
			if (!(err instanceof GitHubRateLimitedError)) throw err;
			this.keep(key, update, err.retryAt, now, false);
			await this.schedule(err.retryAt);
		}
	}

	/** Stores update as pending, due at due; replace=false keeps a newer pending update. */
	private keep(key: string, update: CheckUpdate, due: number, now: number, replace: boolean): void {
		this.sql.exec(
			`INSERT INTO check_state (key, pending, due_at, touched_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (key) DO UPDATE SET pending = ${replace ? "excluded.pending" : "coalesce(pending, excluded.pending)"},
			due_at = max(coalesce(due_at, 0), excluded.due_at), touched_at = excluded.touched_at`,
			key,
			JSON.stringify(update),
			due,
			now,
		);
	}

	/** Moves the DO's single alarm earlier to at, never later. */
	private async schedule(at: number): Promise<void> {
		const set = await this.host.storage.getAlarm();
		if (set === null || set > at) await this.host.storage.setAlarm(at);
	}
}
