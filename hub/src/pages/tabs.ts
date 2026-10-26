// The dashboard's Agents, Repositories and Settings tabs: read-only views of
// stored rows of one installation, in the same chrome as the overview and the
// run list (dashboard.ts). Every dynamic value goes through escapeHtml.

import type { ApiTokenRow } from "../db/api-tokens";
import type { InstallationRow } from "../db/installations";
import type { InstallationUsage, SlackLinkRow } from "../db/tabs";
import { QUOTAS } from "../quotas";
import { S } from "../strings";
import { type AppTab, accountNav, agoPlain, appPage, type DashboardChrome, initOf, pageHead, viewerOf } from "./dashboard";
import { escapeHtml } from "./layout";
import { icon } from "./shell";

const D = S.dashboard;
const e = escapeHtml;

const CSS = `
.stl{display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
.chip+.chip{margin-left:6px}
td .chip{vertical-align:middle}
.perms{display:flex;flex-wrap:wrap;gap:6px}
.settings .two{align-items:start}
.settings .kv dd a{display:inline-flex}
td.num,th.num{text-align:right}
`;

interface TabView {
	account: InstallationRow;
	accounts: readonly InstallationRow[];
	login: string;
	now: number;
	chrome?: DashboardChrome;
	cookies?: string[];
}

/** The chrome every tab shares: the page head under the account switcher, the tab's cards inside the stack. */
function tabPage(v: TabView, tab: AppTab, head: string, cards: string): Promise<Response> {
	return appPage({
		title: v.account.account_login,
		bodyClass: tab,
		main: `${accountNav(v.accounts, v.account.id)}${head}<div class="stack-gap">${cards}</div>`,
		viewer: viewerOf(v, tab),
		init: initOf(v),
		css: CSS,
		forms: v.chrome !== undefined,
	});
}

export interface SettingsView extends TabView {
	slack: readonly SlackLinkRow[];
	usage: InstallationUsage;
	latestAgentVersion: string;
	tokens: readonly ApiTokenRow[];
	/** The csrf token of the API token create and revoke forms. */
	csrf: string;
}

/** The granted permissions as name: level chips. A value that is not the JSON object GitHub sent shows as none. */
function permissionChips(json: string): string {
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(json);
	} catch {
		parsed = null;
	}
	const entries = typeof parsed === "object" && parsed !== null ? Object.entries(parsed).filter((kv): kv is [string, string] => typeof kv[1] === "string") : [];
	if (entries.length === 0) return e(D.settingsPage.noPermissions);
	return `<span class="perms">${entries
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, level]) => `<span class="chip">${e(name)}: ${e(level)}</span>`)
		.join("")}</span>`;
}

function dateHtml(ms: number): string {
	const iso = new Date(ms).toISOString();
	return `<time datetime="${iso}" title="${iso.slice(0, 16).replace("T", " ")} UTC">${iso.slice(0, 10)}</time>`;
}

function kv(rows: readonly (readonly [string, string])[]): string {
	return `<dl class="kv">${rows.map(([k, val]) => `<dt>${e(k)}</dt><dd>${val}</dd>`).join("")}</dl>`;
}

function installationCard(v: SettingsView): string {
	const T = D.settingsPage;
	const a = v.account;
	const url = T.githubInstallationUrl(a.account_type, a.account_login, a.id);
	const status = a.suspended_at === null ? e(T.active) : `<span class="chip prod">${e(T.suspended(agoPlain(a.suspended_at, v.now)))}</span>`;
	const rows = kv([
		[T.account, e(a.account_login)],
		[T.accountType, e(T.accountTypes[a.account_type] ?? a.account_type)],
		[T.installationId, `<span class="mono">${a.id}</span>`],
		[T.installed, dateHtml(a.created_at)],
		[T.status, status],
		[T.permissions, permissionChips(a.permissions)],
	]);
	return `<section class="card"><div class="ch"><h2>${e(T.installation)}</h2><a href="${e(url)}" rel="noopener noreferrer">${icon("github")}${e(T.manageOnGitHub)}${icon("out")}</a></div>${rows}</section>`;
}

function slackCard(v: SettingsView): string {
	const T = D.settingsPage;
	const chipClass: Record<SlackLinkRow["status"], string> = { active: "chip prev", revoked: "chip prod", uninstalled: "chip" };
	const rows = v.slack
		.map(
			(w) =>
				`<div class="jr"><div class="tx"><b>${e(w.team_name)}</b><span class="d">${e(T.slackLinked(agoPlain(w.linked_at, v.now)))}</span></div><span class="${chipClass[w.status]}">${e(T.slackStatus[w.status] ?? w.status)}</span></div>`,
		)
		.join("");
	const body = v.slack.length === 0 ? `<p class="empty">${e(T.slackNone)}</p>` : rows;
	const add = `<a href="/slack/install?installation_id=${v.account.id}">${icon("slack")}${e(T.slackAdd)}</a>`;
	return `<section class="card"><div class="ch"><h2>${e(T.slack)}</h2>${add}</div>${body}</section>`;
}

function usageCard(v: SettingsView): string {
	const T = D.settingsPage;
	const u = v.usage;
	const rows: [string, string][] = [
		[T.runsToday, e(T.ofLimit(u.runs_today, QUOTAS.runsPerDay))],
		[T.agentsPaired, e(T.ofLimit(u.agents_active, QUOTAS.agentsPerInstallation))],
		[T.repositories, String(u.repos)],
		[T.runsTotal, String(u.runs_total)],
		[T.retention, e(T.days(QUOTAS.retentionDays))],
		[T.logLimit, e(T.mib(Math.round(QUOTAS.logBytes / 1_048_576)))],
	];
	if (v.latestAgentVersion !== "") rows.push([T.latestAgent, `<span class="mono">${e(v.latestAgentVersion)}</span>`]);
	return `<section class="card"><div class="ch"><h2>${e(T.usage)}</h2></div>${kv(rows)}</section>`;
}

function sessionCard(v: SettingsView): string {
	const T = D.settingsPage;
	const rows = kv([[T.username, e(v.login)]]);
	const link = v.chrome?.settings ? `<a href="/account/settings">${e(T.accountSettings)}${icon("arrow")}</a>` : "";
	return `<section class="card"><div class="ch"><h2>${e(T.you)}</h2>${link}</div>${rows}</section>`;
}

function tokenRow(v: SettingsView, t: ApiTokenRow): string {
	const A = S.apiTokens;
	const base = `/${v.account.id}/tokens`;
	const status =
		t.revoked_at === null
			? `<form method="post" action="${e(`${base}/${encodeURIComponent(t.token_id)}/revoke`)}" data-confirm="${e(A.revokeConfirm)}"><input type="hidden" name="csrf" value="${e(v.csrf)}"><button class="bt dg" type="submit">${e(A.revoke)}</button></form>`
			: `<span class="chip prod">${e(A.revoked)}</span>`;
	const used = t.last_used_at === null ? e(A.never) : dateHtml(t.last_used_at);
	return `<div class="jr"><div class="tx"><b>${e(t.name)}</b><span class="d mono">${e(t.token_id)}&hellip;</span><span class="d">${e(A.created)}: ${dateHtml(t.created_at)} &middot; ${e(A.lastUsed)}: ${used}</span></div>${status}</div>`;
}

function tokensCard(v: SettingsView): string {
	const A = S.apiTokens;
	const rows = v.tokens.length === 0 ? `<p class="empty">${e(A.none)}</p>` : v.tokens.map((t) => tokenRow(v, t)).join("");
	const form =
		`<form class="cf" method="post" action="${e(`/${v.account.id}/tokens`)}"><input type="hidden" name="csrf" value="${e(v.csrf)}">` +
		`<label>${e(A.createLabel)}<input name="name" maxlength="100" placeholder="${e(A.createPlaceholder)}" autocomplete="off" required></label>` +
		`<button class="bt" type="submit">${e(A.create)}</button></form>`;
	return `<section class="card"><div class="ch"><h2>${e(A.title)}</h2></div><p class="sub">${e(A.subtitle)}</p>${rows}${form}</section>`;
}

export function settingsPage(v: SettingsView): Promise<Response> {
	const T = D.settingsPage;
	const cards = `${installationCard(v)}<div class="two">${usageCard(v)}${slackCard(v)}</div>${sessionCard(v)}${tokensCard(v)}`;
	return tabPage(v, "settings", pageHead(T.title, T.subtitle), cards);
}
