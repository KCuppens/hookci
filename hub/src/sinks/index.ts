// The sinks that hear about run and agent changes, and the fan-out that calls
// them without letting one slow or failing sink hold up the run lifecycle.

import type { Env } from "../env";
import { reportError } from "../observability";
import type { Sink } from "./types";

/** What fanOut needs from a Worker's ExecutionContext (Hono's included) or a DurableObjectState. */
export type WaitUntil = Pick<ExecutionContext, "waitUntil">;

/** Builds the named sink for an installation, or null when the installation does not use it. */
export type SinkFactory = (env: Env, installationId: number) => Sink | null;

const factories = new Map<string, SinkFactory>();

/** Adds factory under name, replacing any earlier one; returns a function that removes it. */
export function registerSinkFactory(name: string, factory: SinkFactory): () => void {
	factories.set(name, factory);
	return () => {
		if (factories.get(name) === factory) factories.delete(name);
	};
}

/** The sinks the installation uses; a factory that throws is reported and skipped. */
export async function sinksFor(env: Env, installationId: number): Promise<Sink[]> {
	const sinks: Sink[] = [];
	for (const [name, factory] of factories) {
		try {
			const sink = factory(env, installationId);
			if (sink) sinks.push(sink);
		} catch (err) {
			reportError(err, { sink: name, installation_id: installationId, op: "sink_factory" });
		}
	}
	return sinks;
}

/**
 * Calls fn for every sink now and keeps each call alive with ctx.waitUntil
 * instead of awaiting it. A sink that throws or rejects is reported; nothing
 * reaches the caller.
 */
export function fanOut(ctx: WaitUntil, sinks: readonly Sink[], fn: (sink: Sink) => Promise<void>): void {
	for (const sink of sinks) {
		const call = new Promise<void>((resolve) => resolve(fn(sink))).catch((err: unknown) => reportError(err, { sink: sink.name }));
		ctx.waitUntil(call);
	}
}
