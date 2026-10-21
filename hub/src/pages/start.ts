import { S } from "../strings";
import { escapeHtml, page } from "./layout";

/** The landing page; installUrl carries a fresh state whose cookie is stateCookie. */
export function startPage(installUrl: string, stateCookie: string): Response {
	return page(
		S.pages.startTitle,
		`<p>${escapeHtml(S.pages.startIntro)}</p>
<p>${escapeHtml(S.pages.startSteps)}</p>
<p><a href="${escapeHtml(installUrl)}">${escapeHtml(S.pages.startButton)}</a></p>`,
		{ cookies: [stateCookie] },
	);
}
