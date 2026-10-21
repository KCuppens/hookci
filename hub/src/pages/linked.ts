import { S } from "../strings";
import { escapeHtml, page } from "./layout";

/**
 * The start of /hookci me in the browser: names the Slack user being linked
 * and asks before going to GitHub, so a link someone else sent cannot bind
 * this browser's GitHub account to them unseen.
 */
export function linkConfirmPage(state: string, workspace: string, slackUserId: string, cookie: string): Response {
	return page(
		S.pages.linkConfirmTitle,
		`<p>${escapeHtml(S.pages.linkConfirm(workspace, slackUserId))}</p>
<form method="post" action="/github/link/start"><input type="hidden" name="t" value="${escapeHtml(state)}"><button type="submit">${escapeHtml(S.pages.linkConfirmButton)}</button></form>`,
		{ cookies: [cookie] },
	);
}

/** The end of /hookci me: says which GitHub account the Slack user is now linked to. */
export function linkedPage(login: string, cookies: string[]): Response {
	return page(S.pages.linkedTitle, `<p>${escapeHtml(S.pages.linkedAs(login))}</p>`, { cookies });
}
