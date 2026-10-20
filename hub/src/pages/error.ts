import { S } from "../strings";
import { escapeHtml, page } from "./layout";

const MESSAGES: Readonly<Record<string, string | undefined>> = S.pages.errors;

/** The page for a failed browser flow, with the HubError code's message and a link back to /start. */
export function errorPage(code: string, status: number, cookies: string[] = []): Response {
	return page(
		S.pages.errorTitle,
		`<p>${escapeHtml(MESSAGES[code] ?? S.pages.errorFallback)}</p>
<p><a href="/start">${escapeHtml(S.pages.startAgain)}</a></p>`,
		{ status, cookies },
	);
}
