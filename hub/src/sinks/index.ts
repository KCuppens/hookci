// The sinks that hear about run and agent changes, and the fan-out that calls
// them without letting one slow or failing sink hold up the run lifecycle.

import { listSinkConfigs } from "../db/sinks";
import { tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { reportError } from "../observability";
import { OutboxSink } from "./outbox-sink";
import type { Sink } from "./types";

/** What fanOut needs from a Worker's ExecutionContext (Hono's included) or a DurableObjectState. */
export type WaitUntil = Pick<ExecutionContext, "waitUntil">;

/** The AgentDO a fan-out runs in, for sinks that keep state between calls; absent in the Worker. */
export interface SinkHost {
	storage: DurableObjectStorage;
	now(): number;
}

/** Builds the named sink for an installation, or null when the installation does not use it. */
export type SinkFactory = (env: Env, installationId: number, host?: SinkHost) => Sink | null;

const factories = new Map<string, SinkFactory>();

/** Adds factory under name, replacing any earlier one; returns a function that removes it. */
export function registerSinkFactory(name: string, factory: SinkFactory): () => void {
	factories.set(name, factory);
	return () => {
		if (factories.get(name) === factory) factories.delete(name);
	};
}

/** The sinks the installation uses; a factory that throws is reported and skipped. */
export async function sinksFor(env: Env, installationId: number, host?: SinkHost): Promise<Sink[]> {
	const sinks: Sink[] = [];
	for (const [name, factory] of factories) {
		try {
			const sink = factory(env, installationId, host);
			if (sink) sinks.push(sink);
		} catch (err) {
			reportError(err, { sink: name, installation_id: installationId, op: "sink_factory" });
		}
	}
	return sinks;
}

/** The sinks for a run of repo: those of sinksFor, then one OutboxSink per enabled sink config of the repo. */
export async function sinksForRun(env: Env, installationId: number, repo: string, host?: SinkHost): Promise<Sink[]> {
	const sinks = await sinksFor(env, installationId, host);
	try {
		for (const cfg of await listSinkConfigs(tenantDb(env.DB, installationId), repo)) sinks.push(new OutboxSink(env, installationId, cfg));
	} catch (err) {
		reportError(err, { installation_id: installationId, op: "sink_configs" });
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
