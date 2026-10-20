// The Sink for one configured outbound sink: it hands every run update to the
// sink's SinkOutboxDO, which delivers it on its own schedule.

import type { SinkConfigRow } from "../db/sinks";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { reportError } from "../observability";
import { TERMINAL } from "../slack/badge";
import type { RunView, Sink } from "./types";

export class OutboxSink implements Sink {
	readonly name: string;

	constructor(
		private readonly env: Env,
		private readonly installationId: number,
		private readonly cfg: SinkConfigRow,
	) {
		this.name = `outbox:${cfg.kind}:${cfg.id}`;
	}

	async onRunUpdate(run: RunView): Promise<void> {
		await this.enqueue(run);
	}

	async onJobPlanned(run: RunView): Promise<void> {
		await this.enqueue(run);
	}

	async onJobUpdate(run: RunView): Promise<void> {
		await this.enqueue(run);
	}

	/** Annotations go to GitHub checks only. */
	async onAnnotations(): Promise<void> {}

	/** Agent outages are told to Slack only. */
	async onAgentOffline(): Promise<void> {}

	/** Queues run on the sink's outbox; a failure is reported, never thrown, and names no target or secret. */
	private async enqueue(run: RunView): Promise<void> {
		try {
			const outbox = this.env.SINK_OUTBOX.get(this.env.SINK_OUTBOX.idFromName(`${this.installationId}:${this.cfg.id}`));
			await outbox.enqueue({
				installationId: this.installationId,
				sinkId: this.cfg.id,
				runId: run.triggerId,
				terminal: TERMINAL.has(run.state),
				payload: run,
				enqueuedAt: (this.env.__TEST_CLOCK ?? systemClock).now(),
			});
		} catch (err) {
			reportError(err, { installation_id: this.installationId, sink: this.name, run_id: run.triggerId, op: "sink_enqueue" });
		}
	}
}
