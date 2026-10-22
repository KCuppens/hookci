// POST /app/:installationId/runs/:runId/{approve,cancel,retry}: the buttons on
// the dashboard's run page. Access is the run page's (the session covers the
// installation, the run belongs to it) plus what the Slack buttons ask for:
// write access to the repository on GitHub. The form carries a csrf token and
// must come from the hub's own origin.

import type { Context } from "hono";
import { readCheckedForm } from "../accounts/csrf";
import { availableRunActions, type RunAction, type RunNotice, runNoticePath } from "../dashboard/run-actions";
import { getRepo } from "../db/repos";
import { getRunListRow } from "../db/runs";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { approveForkRun } from "../forks/gate";
import { logEvent } from "../observability";
import { notFoundPage } from "../pages/dashboard";
import { escapeHtml, page } from "../pages/layout";
import { cancelRun } from "../runs/cancel";
import { retryRun } from "../runs/retry";
import { commandGitHub, requirePermission } from "../slack/resolve";
import { S } from "../strings";
import { scopeOf } from "./dashboard";

type AppContext = Context<{ Bindings: Env }>;

const APPROVE_CONFLICT = { stale: S.forks.staleApproval, already_used: S.forks.alreadyApproved, not_gated: S.forks.notGated } as const;
const UNAVAILABLE: Record<RunAction, string> = { approve: S.forks.notGated, cancel: S.runActions.notCancellable, retry: S.runActions.notRetryable };

function conflict(installationId: number, runId: string, message: string, status = 409): Response {
	const back = `/app/${installationId}/runs/${encodeURIComponent(runId)}`;
	return page(S.runActions.conflictTitle, `<p>${escapeHtml(message)}</p>\n<p><a href="${escapeHtml(back)}">${escapeHtml(S.runActions.backToRun)}</a></p>`, { status });
}

async function perform(c: AppContext, action: RunAction): Promise<Response> {
	const scope = await scopeOf(c);
	if (!scope) return notFoundPage();
	const { session, t } = scope;
	const installationId = scope.account.id;
	const runId = c.req.param("runId") ?? "";
	if (!(await readCheckedForm(c.env, c.req.raw))) return conflict(installationId, runId, S.runActions.csrf, 403);
	const run = await getRunListRow(t, runId);
	if (!run) return notFoundPage();
	const repo = await getRepo(t, run.repo_id);
	if (!repo) return notFoundPage();
	try {
		await requirePermission(c.env, commandGitHub(c.env), installationId, repo.full_name, session.githubLogin, "write");
	} catch (err) {
		if (!(err instanceof HubError && err.code === "forbidden")) throw err;
		logEvent("tenant_denied", { installation_id: installationId, github_user_id: session.githubUserId, run_id: run.run_id, reason: "run_action_not_writer" });
		return conflict(installationId, runId, S.runActions.notAllowed, 403);
	}
	if (!availableRunActions(run)[action]) return conflict(installationId, runId, UNAVAILABLE[action]);
	const done = (notice: RunNotice) => {
		logEvent("run_action", { installation_id: installationId, repo_id: run.repo_id, run_id: run.run_id, action, via: "dashboard", actor: session.githubUserId, notice });
		return new Response(null, { status: 303, headers: { location: runNoticePath(installationId, run.run_id, notice), "cache-control": "no-store" } });
	};

	if (action === "approve") {
		const outcome = await approveForkRun(c.env, {
			installationId,
			runId: run.run_id,
			headSha: run.sha,
			approverGithubId: session.githubUserId,
			approverLogin: session.githubLogin,
			via: "dashboard",
		});
		return outcome === "dispatched" ? done("approved") : conflict(installationId, runId, APPROVE_CONFLICT[outcome]);
	}
	if (action === "cancel") {
		const outcome = await cancelRun(c.env, t, run, (c.env.__TEST_CLOCK ?? systemClock).now());
		return outcome === "not_open" ? conflict(installationId, runId, S.runActions.notCancellable) : done(outcome);
	}
	const target = { installationId, repoId: repo.repo_id, fullName: repo.full_name, defaultBranch: repo.default_branch };
	const outcome = await retryRun(c.env, commandGitHub(c.env), target, run);
	switch (outcome.kind) {
		case "no_agent":
			return conflict(installationId, runId, S.runActions.retryNoAgent);
		case "fork_never":
			return conflict(installationId, runId, S.runActions.retryForkNever);
		case "duplicate":
			return conflict(installationId, runId, S.runActions.retryDuplicate);
		case "gated":
			return done("retryGated");
		case "offline":
			return done("retryOffline");
		case "retried":
			return done("retried");
	}
}

export const runApprove = (c: AppContext): Promise<Response> => perform(c, "approve");
export const runCancel = (c: AppContext): Promise<Response> => perform(c, "cancel");
export const runRetry = (c: AppContext): Promise<Response> => perform(c, "retry");
