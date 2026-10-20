// The providers a SinkOutboxDO hands queued run updates to, one per sink kind.

import type { SinkConfigWithSecret, SinkKind } from "../db/sinks";
import type { Env } from "../env";
import type { RunView } from "./types";

/** What one delivery attempt came to. afterMs replaces the outbox's own backoff step; disable turns the sink off for that reason. */
export type DeliveryResult =
	| { kind: "ok"; externalId?: string }
	| { kind: "retry"; afterMs?: number; httpStatus?: number }
	| { kind: "fail"; httpStatus?: number; disable?: string };

/** A run update queued for one sink. */
export interface OutboxItem {
	installationId: number;
	sinkId: string;
	/** The run's RunView.triggerId, which stays the same from trigger to finish. */
	runId: string;
	terminal: boolean;
	payload: RunView;
	enqueuedAt: number;
}

/** An OutboxItem as handed to a deliverer: deliveryId stays the same across the retries of one enqueued update. */
export interface OutboxDelivery extends OutboxItem {
	deliveryId: string;
}

export interface Deliverer {
	/** Sends item to cfg's target; attempt counts from 1. Throwing counts as a retry. */
	deliver(env: Env, cfg: SinkConfigWithSecret, item: OutboxDelivery, attempt: number): Promise<DeliveryResult>;
}

const deliverers = new Map<SinkKind, Deliverer>();

/** Adds d for kind, replacing any earlier one; returns a function that removes it. */
export function registerDeliverer(kind: SinkKind, d: Deliverer): () => void {
	deliverers.set(kind, d);
	return () => {
		if (deliverers.get(kind) === d) deliverers.delete(kind);
	};
}

export function delivererFor(kind: SinkKind): Deliverer | null {
	return deliverers.get(kind) ?? null;
}
