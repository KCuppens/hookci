// What the run page needs for its Approve, Cancel and Retry buttons: which
// buttons apply to a run, the csrf token their forms carry, and the notice a
// finished action leaves on the page. The POST routes live in
// routes/run-actions.ts.

import { csrfForForm } from "../accounts/csrf";
import type { RunRow } from "../db/runs";
import type { Env } from "../env";
import { TERMINAL } from "../slack/badge";
import { S } from "../strings";

export type RunAction = "approve" | "cancel" | "retry";

export type RunActions = Record<RunAction, boolean>;

export type RunNotice = keyof typeof S.runActions.notices;

/**
 * Approve: a fork run waiting for approval. Cancel: a run that has not
 * finished and can still run (a fork run that never runs has nothing to
 * cancel). Retry: a finished run.
 */
export function availableRunActions(run: Pick<RunRow, "state" | "reason" | "pr_number" | "agent_id">): RunActions {
	const gated = run.state === "gated";
	const finished = (TERMINAL as ReadonlySet<string>).has(run.state);
	return {
		approve: gated && run.reason === "fork_gated" && run.pr_number !== null && run.agent_id !== null,
		cancel: !finished && !(gated && run.reason === "fork_never"),
		retry: finished,
	};
}

/** The path the form of action posts to. */
export function runActionPath(installationId: number, runId: string, action: RunAction): string {
	return `/app/${installationId}/runs/${encodeURIComponent(runId)}/${action}`;
}

/** The redirect target after an action: the run page with `?notice=<key>`. */
export function runNoticePath(installationId: number, runId: string, notice: RunNotice): string {
	return `/app/${installationId}/runs/${encodeURIComponent(runId)}?notice=${notice}`;
}

/** The notice text for the request's `?notice=` value, or null when it is absent or not one of ours. */
export function runNoticeText(url: string): string | null {
	const key = new URL(url).searchParams.get("notice");
	return key !== null && Object.hasOwn(S.runActions.notices, key) ? S.runActions.notices[key as RunNotice] : null;
}

/**
 * The buttons, csrf token, Set-Cookie list (the csrf cookie when the browser has none) and notice text for a run page.
 * When the page header already carries a csrf token (dashboardChrome), pass it as chromeCsrf: it is reused and no second cookie is minted, since two fresh cookies of one name would invalidate one token.
 */
export async function runActionsView(
	env: Env,
	request: Request,
	run: Pick<RunRow, "state" | "reason" | "pr_number" | "agent_id">,
	chromeCsrf: string | null = null,
): Promise<{ actions: RunActions; csrf: string; cookies: string[]; notice: string | null }> {
	const { token, cookie } = chromeCsrf === null ? await csrfForForm(env, request.headers.get("cookie")) : { token: chromeCsrf, cookie: null };
	return { actions: availableRunActions(run), csrf: token, cookies: cookie === null ? [] : [cookie], notice: runNoticeText(request.url) };
}
