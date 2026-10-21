// Server-rendered HTML for the read-only dashboard. Like layout.ts every
// dynamic value goes through escapeHtml, but these pages are styled: their one
// inline stylesheet is allowed by its hash in the CSP and no script runs.

import type { AgentRow } from "../db/agents";
import type { InstallationRow } from "../db/installations";
import type { JobLogRow, RunListRow } from "../db/runs";
import { QUOTAS } from "../quotas";
import { formatDuration } from "../slack/badge";
import { S } from "../strings";
import { escapeHtml, type PageInit } from "./layout";

const D = S.dashboard;

const STYLE = `
:root{color-scheme:light dark;--fg:#1f2328;--bg:#ffffff;--muted:#59636e;--line:#d1d9e0;--ok:#1a7f37;--bad:#cf222e;--busy:#9a6700;--link:#0969da}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--line:#3d444d;--ok:#3fb950;--bad:#f85149;--busy:#d29922;--link:#4493f8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--link)}
.top{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;align-items:center;justify-content:space-between;padding:.75rem 1rem;border-bottom:1px solid var(--line)}
.brand{font-weight:700;color:var(--fg);text-decoration:none}
.who{color:var(--muted);font-size:.9rem}
main{max-width:72rem;margin:0 auto;padding:1rem}
h1{font-size:1.5rem;margin:.5rem 0 1rem;overflow-wrap:anywhere}
h2{font-size:1.15rem;margin:2rem 0 .5rem}
.accounts{list-style:none;display:flex;flex-wrap:wrap;gap:.5rem 1rem;margin:0 0 1rem;padding:0}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.85rem;color:var(--muted);font-weight:600;white-space:nowrap}
td.wrap-any,dd{overflow-wrap:anywhere}
.badge{display:inline-block;padding:0 .5rem;border:1px solid currentColor;border-radius:1rem;font-size:.85rem;white-space:nowrap}
.ok{color:var(--ok)}.bad{color:var(--bad)}.busy{color:var(--busy)}.idle{color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0}
dt{color:var(--muted)}dd{margin:0}
.notice{border:1px solid var(--busy);border-radius:.375rem;padding:.25rem .5rem;color:var(--busy);font-size:.9rem}
.button{display:inline-block;padding:.5rem 1rem;border-radius:.375rem;background:var(--link);color:var(--bg);text-decoration:none;font-weight:600}
.muted{color:var(--muted)}
.acct{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center}
.acct form{margin:0}
.linkbtn{padding:0;border:0;background:none;color:var(--link);font:inherit;text-decoration:underline;cursor:pointer}
@media (max-width:40rem){main{padding:.75rem}th,td{padding:.35rem .4rem}dl{grid-template-columns:1fr}dt{margin-top:.5rem}}
`;

let styleSource: Promise<string> | undefined;

/** The CSP source for STYLE: its SHA-256 in base64, computed once. */
function styleHash(): Promise<string> {
	styleSource ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE)).then((digest) => {
		let binary = "";
		for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
		return `'sha256-${btoa(binary)}'`;
	});
	return styleSource;
}

/** The signed-in header controls when accounts are on: a sign out form and, for an email account, a link to its settings. */
export interface DashboardChrome {
	csrf: string;
	settings: boolean;
}

/** A complete dashboard page response; title is escaped here, bodyHtml must already be safe HTML. */
export async function dashboardPage(title: string, bodyHtml: string, init: PageInit & { who?: string; chrome?: DashboardChrome } = {}): Promise<Response> {
	const formAction = init.chrome === undefined ? "'none'" : "'self'";
	const headers = new Headers({
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": `default-src 'self'; style-src ${await styleHash()}; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`,
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "no-store",
	});
	for (const cookie of init.cookies ?? []) headers.append("Set-Cookie", cookie);
	const who = init.who === undefined ? "" : `<span class="who">${escapeHtml(D.signedInAs(init.who))}</span>`;
	let controls = who;
	if (init.chrome !== undefined) {
		const settings = init.chrome.settings ? `<a href="/account/settings">${escapeHtml(D.settings)}</a>` : "";
		const signOut = `<form method="post" action="/account/logout"><input type="hidden" name="csrf" value="${escapeHtml(init.chrome.csrf)}"><button class="linkbtn" type="submit">${escapeHtml(D.signOut)}</button></form>`;
		controls = `<div class="acct">${who}${settings}${signOut}</div>`;
	}
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>
<header class="top"><a class="brand" href="/app">HookCI</a>${controls}</header>
<main>
${bodyHtml}
</main>
</body>
</html>`;
	return new Response(html, { status: init.status ?? 200, headers });
}

export function signInPage(): Promise<Response> {
	return dashboardPage(
		D.signInTitle,
		`<h1>${escapeHtml(D.signInTitle)}</h1>
<p>${escapeHtml(D.signInIntro)}</p>
<p><a class="button" href="/app/login">${escapeHtml(D.signInButton)}</a></p>`,
	);
}

/** The page for a user who can access no hub installation; cookies clear the sign-in state cookie. */
export function noInstallationPage(cookies: string[] = [], chrome?: DashboardChrome): Promise<Response> {
	return dashboardPage(
		D.noInstallationTitle,
		`<h1>${escapeHtml(D.noInstallationTitle)}</h1>
<p>${escapeHtml(D.noInstallationBody)}</p>
<p><a class="button" href="/start">${escapeHtml(D.noInstallationButton)}</a></p>`,
		{ cookies, ...(chrome ? { chrome } : {}) },
	);
}

/** One 404 for everything the session cannot see, so an uncovered installation looks like a missing one. */
export function notFoundPage(): Promise<Response> {
	return dashboardPage(
		D.notFoundTitle,
		`<h1>${escapeHtml(D.notFoundTitle)}</h1>
<p>${escapeHtml(D.notFoundBody)}</p>
<p><a class="button" href="/app">${escapeHtml(D.signInAgain)}</a></p>`,
		{ status: 404 },
	);
}

/** UTC, to the minute, in a time element carrying the exact instant. */
function timeHtml(ms: number | null): string {
	if (ms === null) return escapeHtml(D.none);
	const iso = new Date(ms).toISOString();
	return `<time datetime="${iso}">${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC</time>`;
}

function durationText(ms: number | null): string {
	return ms === null ? D.none : formatDuration(ms);
}

const BADGE_CLASS: Readonly<Record<string, string>> = {
	success: "ok",
	failed: "bad",
	interrupted: "bad",
	received: "busy",
	queued: "busy",
	running: "busy",
	verifying: "busy",
	rolling_back: "busy",
};

/** The state in words with a colour; an unknown state shows as it is stored. */
function badge(state: string): string {
	return `<span class="badge ${BADGE_CLASS[state] ?? "idle"}">${escapeHtml(D.state[state] ?? state)}</span>`;
}

/** refs/heads/main shows as main; other refs show whole. */
function branchLabel(ref: string): string {
	return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function refText(run: Pick<RunListRow, "ref" | "pr_number">): string {
	const branch = branchLabel(run.ref);
	return run.pr_number === null ? branch : `${D.pullRequest(run.pr_number)} (${branch})`;
}

function repoText(run: Pick<RunListRow, "repo_name">): string {
	return run.repo_name ?? D.unknownRepo;
}

function accountNav(accounts: readonly InstallationRow[], currentId: number): string {
	if (accounts.length < 2) return "";
	const items = accounts
		.map((a) =>
			a.id === currentId
				? `<li><strong>${escapeHtml(a.account_login)}</strong></li>`
				: `<li><a href="/app/${a.id}">${escapeHtml(a.account_login)}</a></li>`,
		)
		.join("\n");
	return `<ul class="accounts" aria-label="${escapeHtml(D.accounts)}">\n${items}\n</ul>\n`;
}

function agentRows(agents: readonly AgentRow[]): string {
	if (agents.length === 0) return `<p class="muted">${escapeHtml(D.noAgents)}</p>`;
	const rows = agents
		.map((agent) => {
			const status =
				agent.status === "online"
					? escapeHtml(D.agentConnected)
					: agent.last_seen_at === null
						? escapeHtml(D.agentNeverSeen)
						: `${escapeHtml(D.agentLastSeen(""))}${timeHtml(agent.last_seen_at)}`;
			return `<tr><td class="wrap-any">${escapeHtml(agent.name)}</td><td>${status}</td><td>${escapeHtml(agent.agent_version ?? D.none)}</td></tr>`;
		})
		.join("\n");
	return `<div class="wrap"><table>
<thead><tr><th>${escapeHtml(D.cols.name)}</th><th>${escapeHtml(D.cols.status)}</th><th>${escapeHtml(D.cols.version)}</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
}

/** The header and cookie settings shared by the signed-in pages. */
function viewerInit(v: { login: string; chrome?: DashboardChrome; cookies?: string[] }): PageInit & { who: string; chrome?: DashboardChrome } {
	return { who: v.login, ...(v.chrome ? { chrome: v.chrome } : {}), ...(v.cookies ? { cookies: v.cookies } : {}) };
}

export interface RunsView {
	account: InstallationRow;
	accounts: readonly InstallationRow[];
	login: string;
	chrome?: DashboardChrome;
	cookies?: string[];
	runs: readonly RunListRow[];
	/** The rowid to pass as before for the next page; null on the last page. */
	olderCursor: number | null;
	agents: readonly AgentRow[];
}

export function runsPage(v: RunsView): Promise<Response> {
	const base = `/app/${v.account.id}`;
	const rows = v.runs
		.map(
			(run) =>
				`<tr>
<td class="wrap-any"><a href="${base}/runs/${encodeURIComponent(run.run_id)}">${escapeHtml(repoText(run))}</a></td>
<td class="wrap-any">${escapeHtml(refText(run))}</td>
<td class="mono">${escapeHtml(run.sha.slice(0, 7))}</td>
<td>${escapeHtml(run.event)}</td>
<td>${badge(run.state)}</td>
<td>${escapeHtml(durationText(run.duration_ms))}</td>
<td>${timeHtml(run.started_at)}</td>
<td class="wrap-any">${escapeHtml(run.agent_name ?? D.none)}</td>
</tr>`,
		)
		.join("\n");
	const cols = [D.cols.repo, D.cols.branch, D.cols.commit, D.cols.event, D.cols.state, D.cols.duration, D.cols.started, D.cols.agent];
	const table =
		v.runs.length === 0
			? `<p class="muted">${escapeHtml(D.noRuns)}</p>`
			: `<div class="wrap"><table>
<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
	const older = v.olderCursor === null ? "" : `\n<p><a href="${base}?before=${v.olderCursor}">${escapeHtml(D.older)}</a></p>`;
	return dashboardPage(
		v.account.account_login,
		`${accountNav(v.accounts, v.account.id)}<h1>${escapeHtml(v.account.account_login)}</h1>
<h2>${escapeHtml(D.runs)}</h2>
${table}${older}
<h2>${escapeHtml(D.agents)}</h2>
${agentRows(v.agents)}`,
		viewerInit(v),
	);
}

export interface RunView {
	account: InstallationRow;
	login: string;
	chrome?: DashboardChrome;
	cookies?: string[];
	run: RunListRow;
	jobs: readonly JobLogRow[];
}

export function runPage(v: RunView): Promise<Response> {
	const { run } = v;
	const base = `/app/${v.account.id}`;
	const entries: [string, string][] = [
		[D.summary.state, badge(run.state)],
		[D.summary.repo, escapeHtml(repoText(run))],
		[D.summary.branch, escapeHtml(refText(run))],
		[D.summary.commit, `<span class="mono">${escapeHtml(run.sha.slice(0, 7))}</span>`],
		[D.summary.event, escapeHtml(run.event)],
		[D.summary.attempt, String(run.attempt)],
		[D.summary.agent, escapeHtml(run.agent_name ?? D.none)],
		[D.summary.started, timeHtml(run.started_at)],
		[D.summary.finished, timeHtml(run.finished_at)],
		[D.summary.duration, escapeHtml(durationText(run.duration_ms))],
	];
	if (run.reason !== null) entries.splice(1, 0, [D.summary.reason, escapeHtml(run.reason)]);
	if (run.commit_title !== null) entries.push([D.summary.message, escapeHtml(run.commit_title)]);
	if (run.author_login !== null) entries.push([D.summary.author, escapeHtml(run.author_login)]);
	const summary = `<dl>\n${entries.map(([k, val]) => `<dt>${escapeHtml(k)}</dt><dd>${val}</dd>`).join("\n")}\n</dl>`;

	const jobRows = v.jobs
		.map((job) => {
			let log = escapeHtml(D.noLogYet);
			if (job.log_key !== null) {
				const href = `${base}/runs/${encodeURIComponent(run.run_id)}/logs/${encodeURIComponent(job.name)}`;
				log = `<a href="${href}">${escapeHtml(D.viewLog)}</a>`;
				if (job.log_truncated === 1) {
					log += `<br><span class="notice">${escapeHtml(D.logTruncated(QUOTAS.logBytes / 1_048_576))}</span>`;
				}
			}
			return `<tr><td class="wrap-any">${escapeHtml(job.name)}</td><td>${badge(job.state)}</td><td>${escapeHtml(durationText(job.duration_ms))}</td><td>${log}</td></tr>`;
		})
		.join("\n");
	const jobs =
		v.jobs.length === 0
			? `<p class="muted">${escapeHtml(D.noJobs)}</p>`
			: `<div class="wrap"><table>
<thead><tr><th>${escapeHtml(D.cols.job)}</th><th>${escapeHtml(D.cols.state)}</th><th>${escapeHtml(D.cols.duration)}</th><th>${escapeHtml(D.cols.log)}</th></tr></thead>
<tbody>
${jobRows}
</tbody>
</table></div>`;

	const title = D.runTitle(repoText(run));
	return dashboardPage(
		title,
		`<p><a href="${base}">${escapeHtml(D.allRuns)}</a></p>
<h1>${escapeHtml(title)}</h1>
${summary}
<h2>${escapeHtml(D.jobs)}</h2>
${jobs}`,
		viewerInit(v),
	);
}
