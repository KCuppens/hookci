// The account flows, free of HTTP: sign-up, sign-in, password reset, email
// verification, Google sign-in and the GitHub link. Handlers in
// routes/account.ts turn their results into pages. Every flow that takes an
// email address answers the same whether or not an account exists: the result
// type has no "unknown email" case, and unknown addresses cost the same
// password hashing as known ones.

import { hex, hmacSha256 } from "../crypto";
import {
	clearLoginFailures,
	deleteAccount,
	getUserByEmail,
	getUserByGoogleSub,
	getUserById,
	insertUser,
	linkGithub,
	loginLockedUntil,
	markEmailVerified,
	recordLoginFailure,
	refreshGithubLogin,
	setGoogleSub,
	setPasswordHash,
	type UserRow,
} from "../db/accounts";
import { hitIpRate } from "../db/ip-rate";
import type { Env } from "../env";
import { logEvent } from "../observability";
import { QUOTAS } from "../quotas";
import { ulid } from "../ulid";
import { emailSenderFor, existsEmail, type OutgoingEmail, resetEmail, verifyEmail } from "./email";
import type { GoogleIdentity } from "./google";
import { hashPassword, needsRehash, type PasswordProblem as PasswordFailure, passwordProblem, verifyAgainstDummy, verifyPassword } from "./password";
import { consumeToken, issueEmailToken, peekToken } from "./tokens";

const HOUR_MS = 3_600_000;
const POST_WINDOW_MS = 600_000;
const EMAIL_MAX_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+$/;

/** Five wrong passwords lock an address for 15 minutes; failures older than 30 minutes are forgotten. */
export const LOGIN_LOCKOUT = { lockAfter: 5, lockMs: 15 * 60_000, decayMs: 30 * 60_000 } as const;

export interface AccountContext {
	env: Env;
	now: number;
	ip: string;
	/** Runs work after the response (mail sending), so response time does not tell whether a mail was sent. */
	defer(work: Promise<unknown>): void;
}

/** The address trimmed and lowercased, or null when it is not a plausible email address. */
export function normalizeEmail(raw: string): string | null {
	const email = raw.trim().toLowerCase();
	return email.length <= EMAIL_MAX_LENGTH && EMAIL_SHAPE.test(email) ? email : null;
}

/** Keyed hash of an address for rate limit and lockout keys, so those tables never hold addresses. */
async function emailKey(env: Env, emailNorm: string): Promise<string> {
	return hex(await hmacSha256(env.STATE_SIGNING_KEY, `acct-email.${emailNorm}`));
}

/** A short stable tag of an address for logs; never the address. */
async function emailTag(env: Env, emailNorm: string): Promise<string> {
	return (await emailKey(env, emailNorm)).slice(0, 8);
}

async function postAllowed(ctx: AccountContext, action: string): Promise<boolean> {
	const rate = await hitIpRate(ctx.env.DB, `acct_${action}:${ctx.ip}`, QUOTAS.accountPostsPer10MinPerIp, POST_WINDOW_MS, ctx.now);
	return rate.ok;
}

async function mailAllowed(ctx: AccountContext, kind: "mail" | "reset", emailNorm: string, limit: number): Promise<boolean> {
	const rate = await hitIpRate(ctx.env.DB, `acct_${kind}:${await emailKey(ctx.env, emailNorm)}`, limit, HOUR_MS, ctx.now);
	return rate.ok;
}

/** Sends one mail after the response. A missing sender or a failed send is logged (without the address) and otherwise invisible to the browser. */
function sendLater(ctx: AccountContext, tag: string, kind: string, mail: OutgoingEmail): void {
	const sender = emailSenderFor(ctx.env);
	if (!sender) {
		logEvent("account_mail_unconfigured", { kind });
		return;
	}
	ctx.defer(
		sender.send(mail).catch((err: unknown) => {
			logEvent("account_mail_failed", { kind, email: tag, error: err instanceof Error ? err.message : "unknown" });
		}),
	);
}

export type RegisterResult = { ok: true } | { ok: false; reason: "rate_limited" | "invalid_email" | PasswordFailure };

/**
 * Sign-up. A new address gets an unverified account and a verification mail; a
 * registered but unverified one gets its password replaced by this submission
 * (so whoever holds the mailbox ends up owning the password) and a new mail; a
 * verified one gets an "already registered" mail. The browser sees the same
 * result in all three.
 */
export async function register(ctx: AccountContext, rawEmail: string, password: string): Promise<RegisterResult> {
	if (!(await postAllowed(ctx, "register"))) return { ok: false, reason: "rate_limited" };
	const emailNorm = normalizeEmail(rawEmail);
	if (emailNorm === null) return { ok: false, reason: "invalid_email" };
	const problem = passwordProblem(password);
	if (problem !== null) return { ok: false, reason: problem };

	const { env, now } = ctx;
	const passwordHash = await hashPassword(password);
	const tag = await emailTag(env, emailNorm);
	const mailOk = await mailAllowed(ctx, "mail", emailNorm, QUOTAS.accountMailsPerHourPerEmail);
	const existing = await getUserByEmail(env.DB, emailNorm);

	if (existing?.email_verified_at != null) {
		if (mailOk) {
			sendLater(ctx, tag, "exists", existsEmail(emailNorm, `${env.HUB_ORIGIN}/account/login`, `${env.HUB_ORIGIN}/account/forgot-password`));
		}
		return { ok: true };
	}

	let userId = existing?.id;
	if (existing) {
		await setPasswordHash(env.DB, existing.id, passwordHash);
	} else {
		userId = ulid(now);
		const inserted = await insertUser(env.DB, { id: userId, email: emailNorm, emailNorm, passwordHash, verifiedAt: null, googleSub: null, createdAt: now });
		if (!inserted) return { ok: true };
	}
	if (userId !== undefined && mailOk) {
		const token = await issueEmailToken(env.DB, userId, "verify", now);
		sendLater(ctx, tag, "verify", verifyEmail(emailNorm, `${env.HUB_ORIGIN}/account/verify?token=${token}`));
	}
	return { ok: true };
}

export type LoginResult = { ok: true; user: UserRow } | { ok: false; reason: "invalid" | "rate_limited" };

/**
 * Password sign-in. Unknown address, wrong password and unverified address all
 * give "invalid"; every attempt costs one password hash either way. Failures
 * are counted per address hash and lock it after LOGIN_LOCKOUT.lockAfter, so a
 * locked address answers "rate_limited" without looking at the password, for
 * known and unknown addresses alike.
 */
export async function login(ctx: AccountContext, rawEmail: string, password: string): Promise<LoginResult> {
	if (!(await postAllowed(ctx, "login"))) return { ok: false, reason: "rate_limited" };
	const { env, now } = ctx;
	const emailNorm = normalizeEmail(rawEmail);
	if (emailNorm === null) {
		await verifyAgainstDummy(password);
		return { ok: false, reason: "invalid" };
	}
	const key = await emailKey(env, emailNorm);
	const perEmail = await hitIpRate(env.DB, `acct_login_email:${key}`, QUOTAS.accountLoginsPer10MinPerEmail, POST_WINDOW_MS, now);
	if (!perEmail.ok || (await loginLockedUntil(env.DB, key)) > now) return { ok: false, reason: "rate_limited" };

	const user = await getUserByEmail(env.DB, emailNorm);
	const passwordOk = user?.password_hash ? await verifyPassword(password, user.password_hash) : await verifyAgainstDummy(password);
	if (!user || !passwordOk || user.email_verified_at === null) {
		await recordLoginFailure(env.DB, key, now, LOGIN_LOCKOUT);
		return { ok: false, reason: "invalid" };
	}
	await clearLoginFailures(env.DB, key);
	if (user.password_hash && needsRehash(user.password_hash)) await setPasswordHash(env.DB, user.id, await hashPassword(password));
	return { ok: true, user };
}

export type ForgotResult = { ok: true } | { ok: false; reason: "rate_limited" | "invalid_email" };

/** Password reset request: a reset mail goes out only when the address has an account, and the browser cannot tell. */
export async function requestReset(ctx: AccountContext, rawEmail: string): Promise<ForgotResult> {
	if (!(await postAllowed(ctx, "forgot"))) return { ok: false, reason: "rate_limited" };
	const emailNorm = normalizeEmail(rawEmail);
	if (emailNorm === null) return { ok: false, reason: "invalid_email" };
	const { env, now } = ctx;
	const allowed = await mailAllowed(ctx, "reset", emailNorm, QUOTAS.accountResetsPerHourPerEmail);
	const user = await getUserByEmail(env.DB, emailNorm);
	if (user && allowed) {
		const token = await issueEmailToken(env.DB, user.id, "reset", now);
		sendLater(ctx, await emailTag(env, emailNorm), "reset", resetEmail(emailNorm, `${env.HUB_ORIGIN}/account/reset-password?token=${token}`));
	}
	return { ok: true };
}

/** True when the reset token is live; it is not used up. */
export async function resetTokenLive(ctx: AccountContext, token: string): Promise<boolean> {
	return (await peekToken(ctx.env.DB, token, "reset", ctx.now)) !== null;
}

export type ResetResult = { ok: true } | { ok: false; reason: "invalid_token" | "rate_limited" | PasswordFailure };

/**
 * Sets a new password with a reset token and uses the token up. The mailbox is
 * proven by the token, so the address becomes verified. Nobody is signed in by
 * this: the person goes to the sign-in page.
 */
export async function resetPassword(ctx: AccountContext, token: string, password: string): Promise<ResetResult> {
	if (!(await postAllowed(ctx, "reset"))) return { ok: false, reason: "rate_limited" };
	const problem = passwordProblem(password);
	if (problem !== null) {
		return (await peekToken(ctx.env.DB, token, "reset", ctx.now)) === null ? { ok: false, reason: "invalid_token" } : { ok: false, reason: problem };
	}
	const passwordHash = await hashPassword(password);
	const userId = await consumeToken(ctx.env.DB, token, "reset", ctx.now);
	if (userId === null) return { ok: false, reason: "invalid_token" };
	await setPasswordHash(ctx.env.DB, userId, passwordHash);
	await markEmailVerified(ctx.env.DB, userId, ctx.now);
	const user = await getUserById(ctx.env.DB, userId);
	if (user) await clearLoginFailures(ctx.env.DB, await emailKey(ctx.env, user.email_norm));
	return { ok: true };
}

/** True when the verification token is live; it is not used up. Opening the emailed link only checks, so a mail scanner that fetches it cannot burn it. */
export async function verifyTokenLive(ctx: AccountContext, token: string): Promise<boolean> {
	return (await peekToken(ctx.env.DB, token, "verify", ctx.now)) !== null;
}

/** Uses a verification token and marks the address verified; false for a bad, used or expired token. */
export async function verifyEmailToken(ctx: AccountContext, token: string): Promise<boolean> {
	const userId = await consumeToken(ctx.env.DB, token, "verify", ctx.now);
	if (userId === null) return false;
	await markEmailVerified(ctx.env.DB, userId, ctx.now);
	return true;
}

export type DeleteResult = { ok: true } | { ok: false; reason: "wrong" | "rate_limited" };

/**
 * Deletes the signed-in account after a confirmation: the password for an
 * account that has one (wrong guesses count toward the same lockout as
 * sign-in), the account's own email typed out for one that has none. The
 * session cookie alone is not enough, so a stolen cookie cannot erase an account.
 */
export async function deleteOwnAccount(ctx: AccountContext, user: UserRow, proof: string): Promise<DeleteResult> {
	if (!(await postAllowed(ctx, "delete"))) return { ok: false, reason: "rate_limited" };
	const { env, now } = ctx;
	const key = await emailKey(env, user.email_norm);
	if ((await loginLockedUntil(env.DB, key)) > now) return { ok: false, reason: "rate_limited" };
	if (user.password_hash) {
		if (!(await verifyPassword(proof, user.password_hash))) {
			await recordLoginFailure(env.DB, key, now, LOGIN_LOCKOUT);
			return { ok: false, reason: "wrong" };
		}
		await clearLoginFailures(env.DB, key);
	} else if (normalizeEmail(proof) !== user.email_norm) {
		return { ok: false, reason: "wrong" };
	}
	await deleteAccount(env.DB, user.id);
	logEvent("account_deleted", { account_id: user.id });
	return { ok: true };
}

export type GoogleResult =
	| { ok: true; user: UserRow }
	| { ok: false; reason: "unverified" | "conflict" };

/**
 * Account for a Google identity. A known Google subject signs in. A verified
 * Google email joins an existing account only when that account's own email is
 * verified too; an unverified account with the address is never merged and the
 * sign-in is refused. Otherwise a verified Google-only account is created.
 */
export async function signInWithGoogle(ctx: AccountContext, identity: GoogleIdentity): Promise<GoogleResult> {
	const { env, now } = ctx;
	if (!identity.emailVerified) return { ok: false, reason: "unverified" };
	const bySub = await getUserByGoogleSub(env.DB, identity.sub);
	if (bySub) return { ok: true, user: bySub };
	const emailNorm = normalizeEmail(identity.email);
	if (emailNorm === null) return { ok: false, reason: "unverified" };

	const existing = await getUserByEmail(env.DB, emailNorm);
	if (existing) {
		if (existing.email_verified_at === null || existing.google_sub !== null) return { ok: false, reason: "conflict" };
		if (!(await setGoogleSub(env.DB, existing.id, identity.sub))) return { ok: false, reason: "conflict" };
		logEvent("account_google_linked", { email: await emailTag(env, emailNorm) });
		return { ok: true, user: { ...existing, google_sub: identity.sub } };
	}
	const id = ulid(now);
	const inserted = await insertUser(env.DB, { id, email: emailNorm, emailNorm, passwordHash: null, verifiedAt: now, googleSub: identity.sub, createdAt: now });
	if (!inserted) return { ok: false, reason: "conflict" };
	const created = await getUserById(env.DB, id);
	return created ? { ok: true, user: created } : { ok: false, reason: "conflict" };
}

export type LinkResult = { ok: true } | { ok: false; reason: "conflict" | "unknown_account" };

/**
 * Ties the account to the GitHub user who just completed GitHub authorization.
 * One GitHub user belongs to one account (a unique index), and an account never
 * changes GitHub user once linked, so nothing is merged. Which installations
 * that person may see is still GitHub's answer for their token, not the email.
 */
export async function linkGithubUser(env: Env, accountId: string, github: { id: number; login: string }): Promise<LinkResult> {
	const account = await getUserById(env.DB, accountId);
	if (!account) return { ok: false, reason: "unknown_account" };
	if (account.github_user_id === null) {
		return (await linkGithub(env.DB, accountId, github.id, github.login)) ? { ok: true } : { ok: false, reason: "conflict" };
	}
	if (account.github_user_id !== github.id) return { ok: false, reason: "conflict" };
	await refreshGithubLogin(env.DB, accountId, github.login);
	return { ok: true };
}
