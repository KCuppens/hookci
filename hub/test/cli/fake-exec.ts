import { expect } from "vitest";
import type { Exec, ExecResult } from "../../cli/wrangler.js";

export interface FakeCall {
	args: string[];
	stdin?: string;
}

export type FakeScript = { match: (args: string[]) => boolean; result: ExecResult }[];
export type FakeExec = Exec & { calls: FakeCall[] };

/** A scripted wrangler: each call answers with the first matching result; an unscripted call fails the test. */
export function fakeExec(script: FakeScript): FakeExec {
	const calls: FakeCall[] = [];
	const exec: Exec = async (args, opts) => {
		calls.push(opts?.stdin === undefined ? { args: [...args] } : { args: [...args], stdin: opts.stdin });
		const step = script.find((s) => s.match(args));
		if (!step) expect.unreachable(`unscripted wrangler ${args.join(" ")}`);
		return step.result;
	};
	return Object.assign(exec, { calls });
}
