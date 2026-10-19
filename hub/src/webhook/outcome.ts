import type { Env } from "../env";
import type { HubTrigger } from "../github/normalize";
import { logEvent } from "../observability";
import type { RouteOutcome } from "./route";

/** Reports a trigger that reached no agent; logs it as webhook_outcome. */
export async function notifyOutcome(_env: Env, trig: HubTrigger, outcome: RouteOutcome): Promise<void> {
	logEvent("webhook_outcome", {
		installation_id: trig.installationId,
		repo_id: trig.repoId,
		repo: trig.repo,
		sha: trig.sha,
		target: trig.target,
		outcome: outcome.kind,
	});
}
