// GitHub `check_run` webhook: the "Approve run" button on a gated fork run's
// `hookci` check (requested_action approve_run).

import { APPROVE_ACTION } from "../checks/map";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { approveForkRun } from "../forks/gate";
import { getCollaboratorPermission } from "../github/api";
import { GitHubClient } from "../github/client";
import type { RepoPermission } from "../github/types";
import { defaultFetcher } from "../http";
import { logEvent } from "../observability";
import { AGGREGATE_CHECK } from "../sinks/checks";
import { type HandlerResult, registerHandler } from "./handlers";

export interface CheckRunPayload {
	action: string;
	requested_action?: { identifier: string };
	check_run: { name: string; head_sha: string; external_id: string | null; app: { id: number } };
	installation: { id: number };
	repository: { full_name: string };
	sender: { id: number; login: string };
}

const CAN_APPROVE: Record<RepoPermission, boolean> = { admin: true, maintain: true, write: true, triage: false, read: false, none: false };

export async function onCheckRunEvent(env: Env, p: CheckRunPayload): Promise<HandlerResult> {
	if (p.action !== "requested_action" || p.requested_action?.identifier !== APPROVE_ACTION) return { status: "dropped", note: "not_fork_approval" };
	if (p.check_run.name !== AGGREGATE_CHECK || p.check_run.app.id !== Number(env.GITHUB_APP_ID) || !p.check_run.external_id) {
		return { status: "dropped", note: "foreign_check_run" };
	}
	const clock = env.__TEST_CLOCK ?? systemClock;
	const gh = await new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => clock.now()).installation(p.installation.id);
	const [owner = "", repo = ""] = p.repository.full_name.split("/");
	const permission = await getCollaboratorPermission(gh, owner, repo, p.sender.login);
	if (!CAN_APPROVE[permission]) {
		logEvent("fork_approval_denied", { installation_id: p.installation.id, repo: p.repository.full_name, sender: p.sender.id, permission });
		return { status: "dropped", note: "fork_approval_denied" };
	}
	const outcome = await approveForkRun(env, {
		installationId: p.installation.id,
		runId: p.check_run.external_id,
		headSha: p.check_run.head_sha,
		approverGithubId: p.sender.id,
		approverLogin: p.sender.login,
		via: "check_run",
	});
	return outcome === "dispatched" ? { status: "processed" } : { status: "dropped", note: `fork_approval_${outcome}` };
}

registerHandler("check_run", async (env, payload) => {
	const p = payload as Partial<CheckRunPayload> | null;
	if (!p || typeof p.action !== "string" || !p.check_run || !p.installation || !p.repository || !p.sender) return { status: "dropped", note: "malformed_payload" };
	return onCheckRunEvent(env, p as CheckRunPayload);
});
