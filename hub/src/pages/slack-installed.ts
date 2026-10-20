// Pages of the Slack install: the success page, the Enterprise Grid refusal
// and the page for a browser that has not been through the GitHub install.

import { S } from "../strings";
import { escapeHtml, page } from "./layout";

export interface SlackInstalled {
	teamId: string;
	teamName: string;
	slackAppId: string;
	cookies: string[];
}

/** Says HookCI joined the workspace, what to do next and links to the app's Home tab. */
export function slackInstalledPage(p: SlackInstalled): Response {
	const appHome = `slack://app?team=${encodeURIComponent(p.teamId)}&id=${encodeURIComponent(p.slackAppId)}&tab=home`;
	return page(
		S.pages.slackInstalledTitle,
		`<p>${escapeHtml(S.pages.slackInstalledIn(p.teamName))}</p>
<p>${escapeHtml(S.pages.slackInstalledNext)} <code>${escapeHtml(S.pages.slackWatchCommand)}</code></p>
<p><a href="${escapeHtml(appHome)}">${escapeHtml(S.pages.slackOpenApp)}</a></p>`,
		{ cookies: p.cookies },
	);
}

export function slackGridUnsupportedPage(cookies: string[]): Response {
	return page(S.pages.slackGridTitle, `<p>${escapeHtml(S.pages.slackGridBody)}</p>`, { status: 403, cookies });
}

export function slackStartFromGitHubPage(): Response {
	return page(
		S.pages.slackStartTitle,
		`<p>${escapeHtml(S.pages.slackStartBody)}</p>
<p><a href="/start">${escapeHtml(S.pages.startButton)}</a></p>`,
		{ status: 403 },
	);
}
