// One per outbound sink (`SINK_OUTBOX.idFromName(`${installationId}:${sinkId}`)`).
// It keeps the latest update of each run until the sink's deliverer accepts
// it: a newer update replaces a waiting one, a terminal update is never
// replaced by a non-terminal one, calls to the provider are at least
// OUTBOX_MIN_INTERVAL_MS apart, and a failed attempt is retried on the
// RETRY_DELAYS_MS backoff before the update is given up as failed.

import { DurableObject } from "cloudflare:workers";
import { disableSinkConfig, getSinkConfigWithSecret, recordDelivery, type SinkConfigWithSecret, type SinkDeliveryStatus } from "../db/sinks";
import { type TenantDb, tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { HubError } from "../errors";
import { logEvent, reportError } from "../observability";
import { type DeliveryResult, delivererFor, type OutboxItem } from "../sinks/deliverers";
import { ulid } from "../ulid";
import { type Clock, systemClock } from "./clock";

/** The least time between two calls to the sink's provider. */
export const OUTBOX_MIN_INTERVAL_MS = 1_000;
/** The wait before retry i + 1; an update whose last retry fails too is given up. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;

type MetaKey = "schema_version" | "last_sent_at";

type PendingRow = {
	run_id: string;
	item_json: string;
	terminal: number;
	/** Attempts made so far for this update. */
	attempt: number;
	due_at: number;
};

/** What pending.item_json holds. */
interface StoredItem {
	item: OutboxItem;
	deliveryId: string;
}

// Step i moves the schema from version i to i + 1. Append, never edit.
const MIGRATIONS: ((sql: SqlStorage) => void)[] = [
	(sql) => {
		sql.exec(
			"CREATE TABLE pending (run_id TEXT PRIMARY KEY, item_json TEXT NOT NULL, terminal INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL)",
		);
	},
];

/** Only the error's code or class: a provider error message may carry the target URL or token. */
function errorCode(err: unknown): string {
	if (err instanceof HubError) return err.code;
	return err instanceof Error ? err.name : "unknown";
}

export class SinkOutboxDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		void ctx.blockConcurrencyWhile(async () => this.migrate());
	}

	private get clock(): Clock {
		return this.env.__TEST_CLOCK ?? systemClock;
	}

	/** Queues item for delivery as soon as the spacing allows, replacing the run's waiting update unless that one is terminal and item is not. */
	async enqueue(item: OutboxItem): Promise<void> {
		const waiting = this.sql.exec<{ terminal: number }>("SELECT terminal FROM pending WHERE run_id = ?", item.runId).toArray()[0];
		if (waiting?.terminal === 1 && !item.terminal) return;
		const now = this.clock.now();
		const stored: StoredItem = { item, deliveryId: ulid(now) };
		this.sql.exec(
			`INSERT INTO pending (run_id, item_json, terminal, attempt, due_at) VALUES (?, ?, ?, 0, ?)
			ON CONFLICT (run_id) DO UPDATE SET item_json = excluded.item_json, terminal = excluded.terminal, attempt = 0, due_at = excluded.due_at`,
			item.runId,
			JSON.stringify(stored),
			item.terminal ? 1 : 0,
			now,
		);
		await this.schedule();
	}

	/** Delivers the due updates, oldest first, until the next one has to wait for its time or the spacing. */
	async alarm(): Promise<void> {
		for (;;) {
			const next = this.sql.exec<PendingRow>("SELECT * FROM pending ORDER BY due_at, rowid LIMIT 1").toArray()[0];
			if (!next) return;
			const now = this.clock.now();
			const at = Math.max(next.due_at, this.lastSentAt() + OUTBOX_MIN_INTERVAL_MS);
			if (at > now) {
				await this.ctx.storage.setAlarm(at);
				return;
			}
			await this.attempt(next, now);
		}
	}

	private migrate(): void {
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
			const version = Number(this.meta("schema_version") ?? 0);
			for (const step of MIGRATIONS.slice(version)) step(this.sql);
			this.setMeta("schema_version", String(MIGRATIONS.length));
		});
	}

	private meta(key: MetaKey): string | null {
		return this.sql.exec<{ value: string | null }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
	}

	private setMeta(key: MetaKey, value: string): void {
		this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
	}

	private lastSentAt(): number {
		const at = this.meta("last_sent_at");
		return at === null ? -Infinity : Number(at);
	}

	/** Sets the alarm for the earliest moment a waiting update may go out. */
	private async schedule(): Promise<void> {
		const first = this.sql.exec<{ due_at: number | null }>("SELECT MIN(due_at) AS due_at FROM pending").one().due_at;
		if (first === null) return;
		await this.ctx.storage.setAlarm(Math.max(first, this.lastSentAt() + OUTBOX_MIN_INTERVAL_MS));
	}

	/**
	 * Makes attempt row.attempt + 1 at row's update and settles it: delivered,
	 * rescheduled, given up or dropped. Each change to the row is made only if
	 * enqueue did not replace the update while the provider was being called.
	 */
	private async attempt(row: PendingRow, now: number): Promise<void> {
		const { item, deliveryId } = JSON.parse(row.item_json) as StoredItem;
		const attempt = row.attempt + 1;
		const t = tenantDb(this.env.DB, item.installationId);
		const ctx = { installation_id: item.installationId, sink_id: item.sinkId, run_id: item.runId, attempt };
		const result = await this.send(t, item, deliveryId, attempt, now, ctx);

		let status: SinkDeliveryStatus;
		const step = RETRY_DELAYS_MS[attempt - 1];
		if (result.kind === "retry" && step !== undefined) {
			this.sql.exec(
				"UPDATE pending SET attempt = ?, due_at = ? WHERE run_id = ? AND item_json = ?",
				attempt,
				now + (result.afterMs ?? step),
				row.run_id,
				row.item_json,
			);
			status = "retrying";
		} else {
			this.sql.exec("DELETE FROM pending WHERE run_id = ? AND item_json = ?", row.run_id, row.item_json);
			if (result.kind === "ok") status = "ok";
			else if (result.kind === "drop" || (result.kind === "fail" && result.disable !== undefined)) status = "dropped";
			else status = "failed";
		}

		if (result.kind === "fail" && result.disable !== undefined) {
			try {
				if (await disableSinkConfig(t, item.sinkId, result.disable, now)) logEvent("sink_disabled", { ...ctx, reason: result.disable });
			} catch (err) {
				reportError(err, ctx);
			}
		}
		try {
			await recordDelivery(t, {
				sinkId: item.sinkId,
				deliveryId,
				runId: item.runId,
				attempt,
				status,
				httpStatus: "httpStatus" in result ? (result.httpStatus ?? null) : null,
				at: now,
			});
		} catch (err) {
			reportError(err, ctx);
		}
	}

	/** The result of one attempt; drop when the sink was deleted or disabled or its kind has no deliverer. */
	private async send(
		t: TenantDb,
		item: OutboxItem,
		deliveryId: string,
		attempt: number,
		now: number,
		ctx: Record<string, string | number>,
	): Promise<DeliveryResult | { kind: "drop" }> {
		let cfg: SinkConfigWithSecret | null;
		try {
			cfg = await getSinkConfigWithSecret(this.env, t, item.sinkId);
		} catch (err) {
			logEvent("sink_config_unreadable", { ...ctx, error: errorCode(err) });
			return { kind: "retry" };
		}
		if (!cfg || cfg.disabledAt !== null) return { kind: "drop" };
		const deliverer = delivererFor(cfg.kind);
		if (!deliverer) {
			reportError(new HubError("sink_deliverer_missing", 500, `no deliverer for sink kind ${cfg.kind}`), ctx);
			return { kind: "drop" };
		}
		this.setMeta("last_sent_at", String(now));
		try {
			return await deliverer.deliver(this.env, cfg, { ...item, deliveryId }, attempt);
		} catch (err) {
			logEvent("sink_delivery_error", { ...ctx, error: errorCode(err) });
			return { kind: "retry" };
		}
	}
}
