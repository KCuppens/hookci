import { S } from "../strings";
import { escapeHtml, page } from "./layout";

export interface InstalledView {
	installationId: number;
	accountLogin: string;
	pairToken: string;
	hubOrigin: string;
	expiresInMinutes: number;
	/** Set-Cookie values; include the session that lets this browser poll /start/status. */
	cookies: string[];
}

/**
 * The success page: the install and connect commands for the pair token, the
 * Add to Slack link, and a status line that polls /start/status every 3 s
 * until an agent of the installation is online.
 */
export function installedPage(v: InstalledView): Response {
	const install = `curl -fsSL ${v.hubOrigin}/install | sh -s -- ${v.pairToken}`;
	const connect = `sudo zeroci connect --hub ${v.hubOrigin} ${v.pairToken}`;
	const statusUrl = `/start/status?installation_id=${v.installationId}`;
	return page(
		S.pages.installedTitle,
		`<p>${escapeHtml(S.pages.installedOn(v.accountLogin))}</p>
<p>${escapeHtml(S.pages.installedRunOne)}</p>
<pre>${escapeHtml(install)}</pre>
<pre>${escapeHtml(connect)}</pre>
<p>${escapeHtml(S.pages.installedExpiry(v.expiresInMinutes))}</p>
<p id="agent-status">${escapeHtml(S.pages.agentWaiting)}</p>
<p><a href="/slack/install?installation_id=${v.installationId}">${escapeHtml(S.pages.addToSlack)}</a></p>
<script>
(function () {
	var el = document.getElementById("agent-status");
	var timer = setInterval(function () {
		fetch(${JSON.stringify(statusUrl)}, { credentials: "same-origin" })
			.then(function (r) { return r.ok ? r.json() : null; })
			.then(function (s) {
				if (s && s.agents_online > 0) {
					el.textContent = ${JSON.stringify(S.pages.agentConnected)};
					clearInterval(timer);
				}
			})
			.catch(function () {});
	}, 3000);
})();
</script>`,
		{ cookies: v.cookies },
	);
}

/** Shown to a user who can see the installation but does not administer its account: no pair token, no Add to Slack link. */
export function installedNotAdminPage(accountLogin: string, cookies: string[]): Response {
	return page(
		S.pages.installedTitle,
		`<p>${escapeHtml(S.pages.installedOn(accountLogin))}</p>\n<p>${escapeHtml(S.pages.installedNotAdmin(accountLogin))}</p>`,
		{ cookies },
	);
}

/** Shown for setup_action=update: GitHub changed permissions or repositories; no new pair token. */
export function updatedPage(accountLogin: string, cookies: string[]): Response {
	return page(S.pages.updatedTitle, `<p>${escapeHtml(S.pages.updatedBody(accountLogin))}</p>`, { cookies });
}

/** Lists the installations the user can access; each link finishes the install through /start with the session cookie. */
export function pickerPage(installations: { id: number; accountLogin: string }[], cookies: string[]): Response {
	const items = installations
		.map((i) => `<li><a href="/start?installation_id=${i.id}">${escapeHtml(i.accountLogin)}</a></li>`)
		.join("\n");
	return page(S.pages.pickTitle, `<p>${escapeHtml(S.pages.pickIntro)}</p>\n<ul>\n${items}\n</ul>`, { cookies });
}
