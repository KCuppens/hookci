// A user's cancel of a run that has not finished. The agent holding the run
// is told through its AgentDO, whose own cancelled event ends the run; a run no
// agent holds is cancelled in D1 directly.

import { type RunRow, updateRunState } from "../db/runs";
import type { TenantDb } from "../db/tenant";
import type { Env } from "../env";
import { HubError } from "../errors";

export type CancelOutcome = "cancelled" | "cancelling" | "not_open";

/** Cancels the run; the caller has checked the user may write to the repo. */
export async function cancelRun(env: Env, t: TenantDb, run: RunRow, at: number): Promise<CancelOutcome> {
	if (run.agent_id === null) return (await updateRunState(t, run.run_id, "cancelled", { reason: "cancelled", finished_at: at })) ? "cancelled" : "not_open";
	const res = await env.AGENT_DO.get(env.AGENT_DO.idFromName(run.agent_id)).fetch("https://do/cancel", {
		method: "POST",
		body: JSON.stringify({ run_id: run.run_id }),
	});
	if (res.status === 404 || res.status === 409) return "not_open";
	if (!res.ok) throw new HubError("agent_do_failed", 502, `cancel on ${run.agent_id} answered ${res.status}`);
	return (await res.json<{ cancelled: boolean }>()).cancelled ? "cancelled" : "cancelling";
}
