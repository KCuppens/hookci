// Optional email and Google accounts, mounted under /account and live only when
// ACCOUNTS_ENABLED is "true"; otherwise every path under it answers the
// standard 404, as if the feature did not exist. The flows themselves are in
// accounts/service.ts; this file is HTTP: forms, CSRF, cookies and pages.
//
// Signing in here proves who the person is, not what they may see. An account
// session names no installations until the person also completes GitHub
// authorization (/account/connect-github), which links the account to that
// GitHub user and then follows the same GET /user/installations step as the
// plain GitHub dashboard sign-in.

import { type Context, Hono } from "hono";
import { csrfForForm, readCheckedForm } from "../accounts/csrf";
import { fetchGoogleIdentity, type GoogleIdentity, googleAuthorizeUrl, googleConfigured, newCodeVerifier } from "../accounts/google";
import {
	type AccountContext,
	deleteOwnAccount,
	login,
	register,
	requestReset,
	resetPassword,
	resetTokenLive,
	signInWithGoogle,
	verifyEmailToken,
	verifyTokenLive,
} from "../accounts/service";
import { getUserById, type UserRow } from "../db/accounts";
import { hitIpRate } from "../db/ip-rate";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { redirectToAuthorize } from "../github/oauth";
import { defaultFetcher } from "../http";
import { CLEAR_STATE_COOKIE, consumeState, issueSession, issueState, readAnySession, SESSION_COOKIE, type Session, setCookie } from "../oauth/state";
import {
	checkEmailPage,
	connectGithubPage,
	deleteAccountPage,
	deleteDonePage,
	forgotPasswordPage,
	loginPage,
	registerPage,
	resetDonePage,
	resetInvalidPage,
	resetPasswordPage,
	settingsPage,
	verifyConfirmPage,
	verifyPage,
} from "../pages/account";
import type { DashboardChrome } from "../pages/dashboard";
import { QUOTAS } from "../quotas";
import { S } from "../strings";

type AppContext = Context<{ Bindings: Env }>;

const RATE_WINDOW_MS = 600_000;
const E = S.account.errors;

export function accountsEnabled(env: Env): boolean {
	return env.ACCOUNTS_ENABLED === "true";
}

function contextOf(c: AppContext): AccountContext {
	return {
		env: c.env,
		now: (c.env.__TEST_CLOCK ?? systemClock).now(),
		ip: c.req.header("cf-connecting-ip") ?? "unknown",
		defer(work) {
			try {
				c.executionCtx.waitUntil(work);
			} catch {
				// No execution context (the app called directly, as in a unit test): the work has started and handles its own errors.
			}
		},
	};
}

/** The csrf token for a form, and the Set-Cookie list that gives the browser its csrf cookie when it has none. */
async function csrfOf(c: AppContext): Promise<{ csrf: string; cookies: string[] }> {
	const { token, cookie } = await csrfForForm(c.env, c.req.header("cookie") ?? null);
	return { csrf: token, cookies: cookie === null ? [] : [cookie] };
}

/** What the signed-in dashboard header needs when accounts are on: a sign out form (and a settings link for an email account) with its csrf token and cookie. Nothing when accounts are off. */
export async function dashboardChrome(c: AppContext, session: Session): Promise<{ chrome?: DashboardChrome; cookies?: string[] }> {
	if (!accountsEnabled(c.env)) return {};
	const { csrf, cookies } = await csrfOf(c);
	return { chrome: { csrf, settings: session.accountId !== undefined }, cookies };
}

interface Shown {
	status?: number;
	error?: string;
	email?: string;
	cookies?: string[];
}

/** The sign-in page; also what GET /app shows a browser with no session when accounts are on. */
export async function renderLogin(c: AppContext, shown: Shown = {}): Promise<Response> {
	const { csrf, cookies } = await csrfOf(c);
	const form = { csrf, googleEnabled: googleConfigured(c.env), ...(shown.error ? { error: shown.error } : {}), ...(shown.email ? { email: shown.email } : {}) };
	return loginPage(form, { status: shown.status ?? 200, cookies: [...cookies, ...(shown.cookies ?? [])] });
}

async function renderRegister(c: AppContext, shown: Shown = {}): Promise<Response> {
	const { csrf, cookies } = await csrfOf(c);
	const form = { csrf, googleEnabled: googleConfigured(c.env), ...(shown.error ? { error: shown.error } : {}), ...(shown.email ? { email: shown.email } : {}) };
	return registerPage(form, { status: shown.status ?? 200, cookies });
}

async function renderForgot(c: AppContext, shown: Shown = {}): Promise<Response> {
	const { csrf, cookies } = await csrfOf(c);
	const form = { csrf, googleEnabled: false, ...(shown.error ? { error: shown.error } : {}), ...(shown.email ? { email: shown.email } : {}) };
	return forgotPasswordPage(form, { status: shown.status ?? 200, cookies });
}

async function renderReset(c: AppContext, token: string, shown: Shown = {}): Promise<Response> {
	const { csrf, cookies } = await csrfOf(c);
	const form = { csrf, googleEnabled: false, token, ...(shown.error ? { error: shown.error } : {}) };
	return resetPasswordPage(form, { status: shown.status ?? 200, cookies });
}

function passwordMessage(reason: "too_short" | "too_long" | "needs_number_or_symbol"): string {
	return reason === "too_long" ? E.passwordTooLong : E.passwordRules;
}

/** Signs the browser in as the account: a session that names no installations until GitHub is linked and authorized. */
async function signedInAs(env: Env, user: UserRow, now: number, extraCookies: string[] = []): Promise<Response> {
	const session = await issueSession(
		env,
		// No GitHub identity until GitHub itself authenticates the person in this session.
		{ installationIds: [], githubUserId: 0, githubLogin: "-", accountId: user.id },
		now,
	);
	const headers = new Headers({ Location: "/account/connect-github", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
	for (const cookie of [...extraCookies, session]) headers.append("Set-Cookie", cookie);
	return new Response(null, { status: 303, headers });
}

export const accountRoutes = new Hono<{ Bindings: Env }>();

accountRoutes.use("*", async (c, next) => {
	if (!accountsEnabled(c.env)) throw new HubError("not_found", 404);
	await next();
});

accountRoutes.get("/login", (c) => renderLogin(c));
accountRoutes.get("/register", (c) => renderRegister(c));
accountRoutes.get("/forgot-password", (c) => renderForgot(c));

accountRoutes.post("/login", async (c) => {
	const form = await readCheckedForm(c.env, c.req.raw);
	if (!form) return renderLogin(c, { status: 403, error: E.csrf });
	const ctx = contextOf(c);
	const result = await login(ctx, form.email ?? "", form.password ?? "");
	if (result.ok) return signedInAs(c.env, result.user, ctx.now);
	return result.reason === "rate_limited"
		? renderLogin(c, { status: 429, error: E.rateLimited, ...(form.email ? { email: form.email } : {}) })
		: renderLogin(c, { status: 401, error: E.invalidCredentials, ...(form.email ? { email: form.email } : {}) });
});

accountRoutes.post("/register", async (c) => {
	const form = await readCheckedForm(c.env, c.req.raw);
	if (!form) return renderRegister(c, { status: 403, error: E.csrf });
	const result = await register(contextOf(c), form.email ?? "", form.password ?? "");
	if (result.ok) return checkEmailPage("register", { cookies: [] });
	const email = form.email ? { email: form.email } : {};
	if (result.reason === "rate_limited") return renderRegister(c, { status: 429, error: E.rateLimited, ...email });
	if (result.reason === "invalid_email") return renderRegister(c, { status: 400, error: E.invalidEmail, ...email });
	return renderRegister(c, { status: 400, error: passwordMessage(result.reason), ...email });
});

accountRoutes.post("/forgot-password", async (c) => {
	const form = await readCheckedForm(c.env, c.req.raw);
	if (!form) return renderForgot(c, { status: 403, error: E.csrf });
	const result = await requestReset(contextOf(c), form.email ?? "");
	if (result.ok) return checkEmailPage("forgot", { cookies: [] });
	const email = form.email ? { email: form.email } : {};
	return result.reason === "rate_limited"
		? renderForgot(c, { status: 429, error: E.rateLimited, ...email })
		: renderForgot(c, { status: 400, error: E.invalidEmail, ...email });
});

/** The emailed link only checks the token and asks for a click: a mail scanner or link preview that fetches it cannot use it up. */
accountRoutes.get("/verify", async (c) => {
	const token = c.req.query("token") ?? "";
	if (!(await verifyTokenLive(contextOf(c), token))) return verifyPage(false, { status: 400 });
	const { csrf, cookies } = await csrfOf(c);
	return verifyConfirmPage({ csrf, token }, { cookies });
});

accountRoutes.post("/verify", async (c) => {
	const form = await readCheckedForm(c.env, c.req.raw);
	if (!form) return renderLogin(c, { status: 403, error: E.csrf });
	const ok = await verifyEmailToken(contextOf(c), form.token ?? "");
	return verifyPage(ok, { status: ok ? 200 : 400 });
});

accountRoutes.get("/reset-password", async (c) => {
	const token = c.req.query("token") ?? "";
	if (!(await resetTokenLive(contextOf(c), token))) return resetInvalidPage({ status: 400 });
	return renderReset(c, token);
});

accountRoutes.post("/reset-password", async (c) => {
	const form = await readCheckedForm(c.env, c.req.raw);
	const token = form?.token ?? "";
	if (!form) return renderReset(c, token, { status: 403, error: E.csrf });
	const result = await resetPassword(contextOf(c), token, form.password ?? "");
	if (result.ok) return resetDonePage();
	if (result.reason === "invalid_token") return resetInvalidPage({ status: 400 });
	if (result.reason === "rate_limited") return renderReset(c, token, { status: 429, error: E.rateLimited });
	return renderReset(c, token, { status: 400, error: passwordMessage(result.reason) });
});

/** A per-IP limit shared by the redirect-producing OAuth endpoints, the same budget as the GitHub callbacks. */
async function oauthAllowed(c: AppContext, bucket: string, now: number): Promise<boolean> {
	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	return (await hitIpRate(c.env.DB, `${bucket}:${ip}`, QUOTAS.oauthCallbacksPer10MinPerIp, RATE_WINDOW_MS, now)).ok;
}

accountRoutes.get("/google/start", async (c) => {
	if (!googleConfigured(c.env)) throw new HubError("not_found", 404);
	const now = (c.env.__TEST_CLOCK ?? systemClock).now();
	if (!(await oauthAllowed(c, "acct_google", now))) return renderLogin(c, { status: 429, error: E.rateLimited });
	const verifier = newCodeVerifier();
	const { state, cookie } = await issueState(c.env, "google_login", { verifier }, now);
	return new Response(null, {
		status: 303,
		headers: { Location: await googleAuthorizeUrl(c.env, state, verifier), "Set-Cookie": cookie, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
	});
});

accountRoutes.get("/google/callback", async (c) => {
	const ctx = contextOf(c);
	if (!googleConfigured(c.env)) throw new HubError("not_found", 404);
	const failed = (error: string, status: number) => renderLogin(c, { status, error, cookies: [CLEAR_STATE_COOKIE] });
	if (!(await oauthAllowed(c, "acct_google_cb", ctx.now))) return failed(E.rateLimited, 429);
	const state = c.req.query("state");
	const code = c.req.query("code");
	if (!state) return failed(E.googleFailed, 400);
	let verifier: unknown;
	try {
		verifier = (await consumeState(c.env, "google_login", state, c.req.header("cookie") ?? null, ctx.now)).verifier;
	} catch (err) {
		if (err instanceof HubError) return failed(E.googleFailed, 400);
		throw err;
	}
	if (!code || typeof verifier !== "string" || verifier === "") return failed(E.googleFailed, 400);
	let identity: GoogleIdentity;
	try {
		identity = await fetchGoogleIdentity(c.env, c.env.__TEST_FETCHER ?? defaultFetcher, code, verifier);
	} catch (err) {
		if (err instanceof HubError) return failed(E.googleFailed, 502);
		throw err;
	}
	const result = await signInWithGoogle(ctx, identity);
	if (result.ok) return signedInAs(c.env, result.user, ctx.now, [CLEAR_STATE_COOKIE]);
	return failed(result.reason === "unverified" ? E.googleUnverified : E.googleConflict, 403);
});

/** The account of the signed-in session, or null. */
async function sessionAccount(c: AppContext): Promise<UserRow | null> {
	const now = (c.env.__TEST_CLOCK ?? systemClock).now();
	const session = await readAnySession(c.env, c.req.header("cookie"), now);
	return session?.accountId ? getUserById(c.env.DB, session.accountId) : null;
}

/** Sends the browser to GitHub authorization for this account; the state carries the account id and the callback checks the session still names it. */
async function startGithubLink(c: AppContext, account: UserRow): Promise<Response> {
	const now = (c.env.__TEST_CLOCK ?? systemClock).now();
	if (!(await oauthAllowed(c, "acct_connect", now))) return renderLogin(c, { status: 429, error: E.rateLimited });
	const { state, cookie } = await issueState(c.env, "dashboard_login", { account_id: account.id }, now);
	return redirectToAuthorize(c.env, state, "/github/oauth/callback", cookie);
}

accountRoutes.get("/connect-github", async (c) => {
	const account = await sessionAccount(c);
	if (!account) return toLogin();
	// A linked account has nothing to confirm: GitHub decides what it may see, as at every sign-in.
	if (account.github_user_id !== null) return startGithubLink(c, account);
	const { csrf, cookies } = await csrfOf(c);
	return connectGithubPage({ csrf }, { cookies });
});

accountRoutes.post("/connect-github", async (c) => {
	const form = await readCheckedForm(c.env, c.req.raw);
	if (!form) {
		const { csrf, cookies } = await csrfOf(c);
		return connectGithubPage({ csrf, error: E.csrf }, { status: 403, cookies });
	}
	const account = await sessionAccount(c);
	if (!account) return toLogin();
	return startGithubLink(c, account);
});

const CLEAR_SESSION_COOKIE = setCookie(SESSION_COOKIE, "", 0);

/** Ends the session: the cookie is cleared in the browser. Sessions are stateless, so a copy of the old cookie stays valid until its 30 minutes run out. */
accountRoutes.post("/logout", async (c) => {
	const form = await readCheckedForm(c.env, c.req.raw);
	if (!form) return renderLogin(c, { status: 403, error: E.csrf });
	return new Response(null, {
		status: 303,
		headers: { Location: "/app", "Set-Cookie": CLEAR_SESSION_COOKIE, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
	});
});

function toLogin(): Response {
	return new Response(null, { status: 303, headers: { Location: "/account/login", "Cache-Control": "no-store" } });
}

accountRoutes.get("/settings", async (c) => {
	const account = await sessionAccount(c);
	if (!account) return toLogin();
	const { csrf, cookies } = await csrfOf(c);
	return settingsPage({ csrf, email: account.email, githubLogin: account.github_login }, { cookies });
});

accountRoutes.get("/delete", async (c) => {
	const account = await sessionAccount(c);
	if (!account) return toLogin();
	const { csrf, cookies } = await csrfOf(c);
	return deleteAccountPage({ csrf, hasPassword: account.password_hash !== null }, { cookies });
});

accountRoutes.post("/delete", async (c) => {
	const account = await sessionAccount(c);
	const hasPassword = account === null || account.password_hash !== null;
	const show = async (status: number, error: string): Promise<Response> => {
		const { csrf, cookies } = await csrfOf(c);
		return deleteAccountPage({ csrf, hasPassword, error }, { status, cookies });
	};
	const form = await readCheckedForm(c.env, c.req.raw);
	if (!form) return show(403, E.csrf);
	if (!account) return toLogin();
	const result = await deleteOwnAccount(contextOf(c), account, (hasPassword ? form.password : form.email) ?? "");
	if (result.ok) return deleteDonePage({ cookies: [CLEAR_SESSION_COOKIE] });
	if (result.reason === "rate_limited") return show(429, E.rateLimited);
	return show(401, hasPassword ? S.account.delete.wrongPassword : S.account.delete.wrongEmail);
});
