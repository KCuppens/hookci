// Live log tail: the AgentDO subscribes its agent to a running job's log with
// log_subscribe and fans the agent's log frames out to viewers as
// server-sent events. Viewers of the same job share one subscription. Nothing
// here is stored: a tail lives exactly as long as its viewer streams.

import { base64Bytes } from "../crypto";
import type { Log, LogSubscribe, LogUnsubscribe } from "../protocol";

/** Longest a viewer stream stays open. */
export const STREAM_MAX_MS = 60 * 60 * 1000;
/** Gap between keepalive comments, under the idle timeouts of proxies on the way. */
export const KEEPALIVE_MS = 25_000;
/** Recent events kept per tail for a viewer that joins late, and the most queued for a slow viewer. */
export const BACKLOG_BYTES = 1 << 20;

export const SSE_HEADERS: Readonly<Record<string, string>> = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-store",
};

const encoder = new TextEncoder();
const KEEPALIVE = encoder.encode(": keepalive\n\n");

function sseEvent(event: "log" | "eof" | "offline", data: object): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** A stream that only says the agent is offline. */
export function offlineStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(sseEvent("offline", {}));
			controller.close();
		},
	});
}

/** A log frame's fields, checked. */
export interface LogChunk {
	runId: string;
	job: string;
	offset: number;
	bytes: Uint8Array;
	eof: boolean;
}

/** The fields of a log frame, or null when one has the wrong type or bytes is not base64. */
export function checkLog(frame: Log): LogChunk | null {
	const { run_id: runId, job, offset, bytes, eof } = frame;
	if (typeof runId !== "string" || typeof job !== "string" || typeof bytes !== "string" || typeof eof !== "boolean") return null;
	if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return null;
	const decoded = base64Bytes(bytes);
	return decoded ? { runId, job, offset, bytes: decoded, eof } : null;
}

export type TailFrame = LogSubscribe | LogUnsubscribe;

export interface TailAgent {
	/** Sends a subscription frame to the agent, if it is connected. */
	send(frame: TailFrame): void;
	/** Whether the agent is still connected; checked at every keepalive. */
	online(): boolean;
}

interface Viewer {
	controller: ReadableStreamDefaultController<Uint8Array>;
	timers: number[];
}

interface Tail {
	runId: string;
	job: string;
	viewers: Set<Viewer>;
	decoder: TextDecoder;
	backlog: { offset: number; event: Uint8Array }[];
	backlogBytes: number;
}

export class LiveTails {
	private readonly tails = new Map<string, Tail>();

	constructor(private readonly agent: TailAgent) {}

	/**
	 * A viewer's event stream of job's log from offset. The first viewer of a
	 * job subscribes the agent; later ones replay the backlog from offset and
	 * share the subscription. The last viewer to leave, by cancelling the
	 * stream or aborting signal, unsubscribes it.
	 */
	open(runId: string, job: string, offset: number, signal: AbortSignal): ReadableStream<Uint8Array> {
		const key = JSON.stringify([runId, job]);
		let viewer: Viewer | undefined;
		const gone = (): void => {
			const tail = this.tails.get(key);
			if (viewer && tail) this.leave(tail, viewer, false);
		};
		return new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					const joined: Viewer = { controller, timers: [] };
					viewer = joined;
					let tail = this.tails.get(key);
					if (tail) {
						for (const chunk of tail.backlog) if (chunk.offset >= offset) controller.enqueue(chunk.event);
					} else {
						tail = { runId, job, viewers: new Set(), decoder: new TextDecoder(), backlog: [], backlogBytes: 0 };
						this.tails.set(key, tail);
						this.agent.send({ v: 1, type: "log_subscribe", run_id: runId, job, offset });
					}
					tail.viewers.add(joined);
					const current = tail;
					joined.timers.push(
						setInterval(() => {
							if (!this.agent.online()) this.offline();
							else this.enqueue(current, joined, KEEPALIVE);
						}, KEEPALIVE_MS),
						setTimeout(() => this.leave(current, joined, true), STREAM_MAX_MS),
					);
					signal.addEventListener("abort", gone, { once: true });
				},
				cancel: gone,
			},
			{ highWaterMark: BACKLOG_BYTES, size: (chunk) => chunk.byteLength },
		);
	}

	/** Fans a log frame out to its job's viewers; false when nobody watches that job. */
	deliver(chunk: LogChunk): boolean {
		const tail = this.tails.get(JSON.stringify([chunk.runId, chunk.job]));
		if (!tail) return false;
		const text = tail.decoder.decode(chunk.bytes, { stream: !chunk.eof });
		if (text !== "") {
			const event = sseEvent("log", { offset: chunk.offset, text });
			tail.backlog.push({ offset: chunk.offset, event });
			tail.backlogBytes += event.byteLength;
			while (tail.backlogBytes > BACKLOG_BYTES) tail.backlogBytes -= tail.backlog.shift()?.event.byteLength ?? 0;
			for (const viewer of tail.viewers) this.enqueue(tail, viewer, event);
		}
		if (chunk.eof) this.end(tail, sseEvent("eof", {}));
		return true;
	}

	/** Tells every viewer the agent went offline and closes their streams; the subscriptions died with its socket. */
	offline(): void {
		const event = sseEvent("offline", {});
		for (const tail of [...this.tails.values()]) this.end(tail, event);
	}

	private end(tail: Tail, event: Uint8Array): void {
		this.forget(tail);
		for (const viewer of tail.viewers) {
			stopTimers(viewer);
			viewer.controller.enqueue(event);
			viewer.controller.close();
		}
	}

	/** Queues event for viewer, dropping a viewer too slow to stay within BACKLOG_BYTES. */
	private enqueue(tail: Tail, viewer: Viewer, event: Uint8Array): void {
		if ((viewer.controller.desiredSize ?? 0) < event.byteLength) this.leave(tail, viewer, true);
		else viewer.controller.enqueue(event);
	}

	private leave(tail: Tail, viewer: Viewer, close: boolean): void {
		stopTimers(viewer);
		if (close) viewer.controller.close();
		if (!tail.viewers.delete(viewer) || tail.viewers.size > 0) return;
		this.forget(tail);
		this.agent.send({ v: 1, type: "log_unsubscribe", run_id: tail.runId, job: tail.job });
	}

	private forget(tail: Tail): void {
		const key = JSON.stringify([tail.runId, tail.job]);
		if (this.tails.get(key) === tail) this.tails.delete(key);
	}
}

function stopTimers(viewer: Viewer): void {
	for (const timer of viewer.timers) clearTimeout(timer);
	viewer.timers.length = 0;
}
