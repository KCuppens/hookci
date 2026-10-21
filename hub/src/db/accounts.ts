// Optional accounts (ACCOUNTS_ENABLED): users, emailed single-use tokens and
// failed-sign-in counters. All three tables are global, so these helpers take
// the raw D1Database. Emails reach here already normalised (lowercase), and the
// only token form stored is its SHA-256.

export interface UserRow {
	id: string;
	email: string;
	email_norm: string;
	password_hash: string | null;
	email_verified_at: number | null;
	google_sub: string | null;
	github_user_id: number | null;
	github_login: string | null;
	created_at: number;
}

export type EmailTokenKind = "verify" | "reset";

export interface NewUser {
	id: string;
	email: string;
	emailNorm: string;
	passwordHash: string | null;
	verifiedAt: number | null;
	googleSub: string | null;
	createdAt: number;
}

/** What an export says about an account; never the password hash. */
export interface AccountExport {
	email: string;
	created_at: number;
	email_verified: boolean;
	has_password: boolean;
	google_linked: boolean;
	github_login: string | null;
}

const USER_COLUMNS = "id, email, email_norm, password_hash, email_verified_at, google_sub, github_user_id, github_login, created_at";

export function getUserByEmail(db: D1Database, emailNorm: string): Promise<UserRow | null> {
	return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email_norm = ?1`).bind(emailNorm).first<UserRow>();
}

export function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
	return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?1`).bind(id).first<UserRow>();
}

export function getUserByGoogleSub(db: D1Database, sub: string): Promise<UserRow | null> {
	return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE google_sub = ?1`).bind(sub).first<UserRow>();
}

/** True when the row was inserted; false when the email (or Google subject) already has an account, as when two sign-ups race. */
export async function insertUser(db: D1Database, user: NewUser): Promise<boolean> {
	const { meta } = await db
		.prepare(
			`INSERT OR IGNORE INTO users (id, email, email_norm, password_hash, email_verified_at, google_sub, created_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
		)
		.bind(user.id, user.email, user.emailNorm, user.passwordHash, user.verifiedAt, user.googleSub, user.createdAt)
		.run();
	return meta.changes === 1;
}

export async function setPasswordHash(db: D1Database, id: string, passwordHash: string): Promise<void> {
	await db.prepare("UPDATE users SET password_hash = ?2 WHERE id = ?1").bind(id, passwordHash).run();
}

/** Sets the verified time unless the address is already verified. */
export async function markEmailVerified(db: D1Database, id: string, now: number): Promise<void> {
	await db.prepare("UPDATE users SET email_verified_at = ?2 WHERE id = ?1 AND email_verified_at IS NULL").bind(id, now).run();
}

/** Attaches a Google subject to a verified account; false when it is taken or the account is unverified. */
export async function setGoogleSub(db: D1Database, id: string, sub: string): Promise<boolean> {
	try {
		const { meta } = await db
			.prepare("UPDATE users SET google_sub = ?2 WHERE id = ?1 AND google_sub IS NULL AND email_verified_at IS NOT NULL")
			.bind(id, sub)
			.run();
		return meta.changes === 1;
	} catch {
		return false;
	}
}

/** Links the GitHub user to the account; false when another account has that GitHub user. */
export async function linkGithub(db: D1Database, id: string, githubUserId: number, githubLogin: string): Promise<boolean> {
	try {
		await db.prepare("UPDATE users SET github_user_id = ?2, github_login = ?3 WHERE id = ?1").bind(id, githubUserId, githubLogin).run();
		return true;
	} catch {
		return false;
	}
}

/** Refreshes the stored login of a linked GitHub user, as logins can be renamed. */
export async function refreshGithubLogin(db: D1Database, id: string, githubLogin: string): Promise<void> {
	await db.prepare("UPDATE users SET github_login = ?2 WHERE id = ?1 AND github_login != ?2").bind(id, githubLogin).run();
}

/**
 * Makes tokenHash the only live token of kind for the user: older unused
 * tokens of that kind are retired in the same batch.
 */
export async function replaceEmailToken(
	db: D1Database,
	userId: string,
	kind: EmailTokenKind,
	tokenHash: string,
	now: number,
	ttlMs: number,
): Promise<void> {
	await db.batch([
		db.prepare("UPDATE email_tokens SET used_at = ?3 WHERE user_id = ?1 AND kind = ?2 AND used_at IS NULL").bind(userId, kind, now),
		db
			.prepare("INSERT INTO email_tokens (token_hash, user_id, kind, created_at, expires_at, used_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)")
			.bind(tokenHash, userId, kind, now, now + ttlMs),
	]);
}

/** The user a live token of kind belongs to, without using it. */
export async function peekEmailToken(db: D1Database, tokenHash: string, kind: EmailTokenKind, now: number): Promise<string | null> {
	const row = await db
		.prepare("SELECT user_id FROM email_tokens WHERE token_hash = ?1 AND kind = ?2 AND used_at IS NULL AND expires_at > ?3")
		.bind(tokenHash, kind, now)
		.first<{ user_id: string }>();
	return row?.user_id ?? null;
}

/** Uses a live token of kind once and returns its user; every other unused token of that kind for the user is retired with it. */
export async function consumeEmailToken(db: D1Database, tokenHash: string, kind: EmailTokenKind, now: number): Promise<string | null> {
	const row = await db
		.prepare(
			`UPDATE email_tokens SET used_at = ?3
			WHERE token_hash = ?1 AND kind = ?2 AND used_at IS NULL AND expires_at > ?3 RETURNING user_id`,
		)
		.bind(tokenHash, kind, now)
		.first<{ user_id: string }>();
	if (!row) return null;
	await db.prepare("UPDATE email_tokens SET used_at = ?3 WHERE user_id = ?1 AND kind = ?2 AND used_at IS NULL").bind(row.user_id, kind, now).run();
	return row.user_id;
}

/** The time until which sign-in for the email hash is refused; 0 or past means open. */
export async function loginLockedUntil(db: D1Database, emailHash: string): Promise<number> {
	const row = await db.prepare("SELECT locked_until FROM login_attempts WHERE email_hash = ?1").bind(emailHash).first<{ locked_until: number }>();
	return row?.locked_until ?? 0;
}

/**
 * Counts one failed sign-in for the email hash. Failures older than decayMs
 * start over; reaching lockAfter failures locks the hash for lockMs, and a
 * failure right after the lock ends locks it again.
 */
export async function recordLoginFailure(
	db: D1Database,
	emailHash: string,
	now: number,
	policy: { decayMs: number; lockAfter: number; lockMs: number },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO login_attempts (email_hash, failures, last_failure_at, locked_until) VALUES (?1, 1, ?2, 0)
			ON CONFLICT (email_hash) DO UPDATE SET
				failures = CASE WHEN last_failure_at < ?3 THEN 1 ELSE failures + 1 END,
				locked_until = CASE WHEN (CASE WHEN last_failure_at < ?3 THEN 1 ELSE failures + 1 END) >= ?4 THEN ?5 ELSE locked_until END,
				last_failure_at = ?2`,
		)
		.bind(emailHash, now, now - policy.decayMs, policy.lockAfter, now + policy.lockMs)
		.run();
}

export async function clearLoginFailures(db: D1Database, emailHash: string): Promise<void> {
	await db.prepare("DELETE FROM login_attempts WHERE email_hash = ?1").bind(emailHash).run();
}

/** Deletes the account and its emailed tokens; its failed-sign-in counter is keyed by an email hash and expires by itself. */
export async function deleteAccount(db: D1Database, id: string): Promise<number> {
	const [, users] = await db.batch([
		db.prepare("DELETE FROM email_tokens WHERE user_id = ?1").bind(id),
		db.prepare("DELETE FROM users WHERE id = ?1").bind(id),
	]);
	return users?.meta.changes ?? 0;
}

/** Deletes the accounts linked to the GitHub user; returns how many there were (at most one). */
export async function deleteAccountsOfGithubUser(db: D1Database, githubUserId: number): Promise<number> {
	const [, users] = await db.batch([
		db.prepare("DELETE FROM email_tokens WHERE user_id IN (SELECT id FROM users WHERE github_user_id = ?1)").bind(githubUserId),
		db.prepare("DELETE FROM users WHERE github_user_id = ?1").bind(githubUserId),
	]);
	return users?.meta.changes ?? 0;
}

/** What is stored about the account linked to the GitHub user, or null. */
export async function exportAccountOfGithubUser(db: D1Database, githubUserId: number): Promise<AccountExport | null> {
	const row = await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE github_user_id = ?1`).bind(githubUserId).first<UserRow>();
	if (!row) return null;
	return {
		email: row.email,
		created_at: row.created_at,
		email_verified: row.email_verified_at !== null,
		has_password: row.password_hash !== null,
		google_linked: row.google_sub !== null,
		github_login: row.github_login,
	};
}
