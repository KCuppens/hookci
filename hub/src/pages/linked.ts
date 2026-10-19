import { S } from "../strings";
import { escapeHtml, page } from "./layout";

/** The end of /zeroci me: says which GitHub account the Slack user is now linked to. */
export function linkedPage(login: string, cookies: string[]): Response {
	return page(S.pages.linkedTitle, `<p>${escapeHtml(S.pages.linkedAs(login))}</p>`, { cookies });
}
