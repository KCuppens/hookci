// Signed log links: `${HUB_ORIGIN}/logs/view?i=&r=&j=&exp=&kid=&sig=`, valid 15 minutes.
// sig is base64url HMAC-SHA256 over `v1\n<i>\n<r>\n<j>\n<exp>` under LOG_SIGNING_KEY
// (kid=c) or, during a rotation, LOG_SIGNING_KEY_PREVIOUS (kid=p).

import { base64url, hmacSha256, timingSafeEqual } from "../crypto";
import type { Env } from "../env";
import { checkJobName, isJobName } from "./keys";

export interface LogRef {
	installationId: number;
	runId: string;
	job: string;
}

export const LOG_URL_TTL_SEC = 900;

export type VerifyResult = { ok: true; ref: LogRef } | { ok: false; reason: "expired" | "bad_signature" | "malformed" };

/** The query params a signed link carries, in the order signLogUrl writes them. */
export const SIGNED_PARAMS = ["i", "r", "j", "exp", "kid", "sig"] as const;

const INSTALLATION_ID = /^[1-9][0-9]{0,15}$/;
const EXP = /^[0-9]{1,12}$/;

function signedData(ref: LogRef, exp: number): string {
	return `v1\n${ref.installationId}\n${ref.runId}\n${ref.job}\n${exp}`;
}

/** A link to the job's log page, expiring ttlSec after now; throws bad_job_name (400) for a job name no log can have. */
export async function signLogUrl(env: Env, ref: LogRef, now: Date, ttlSec: number = LOG_URL_TTL_SEC): Promise<string> {
	checkJobName(ref.job);
	const exp = Math.floor(now.getTime() / 1000) + ttlSec;
	const sig = base64url(await hmacSha256(env.LOG_SIGNING_KEY, signedData(ref, exp)));
	const query = new URLSearchParams({ i: String(ref.installationId), r: ref.runId, j: ref.job, exp: String(exp), kid: "c", sig });
	return `${env.HUB_ORIGIN}/logs/view?${query}`;
}

/**
 * Checks a signed link's query. Missing or ill-formed params, an unknown kid and
 * an exp further than LOG_URL_TTL_SEC ahead are malformed; a signature neither
 * key made is bad_signature; a validly signed link past exp is expired.
 */
export async function verifyLogUrl(env: Env, params: URLSearchParams, now: Date): Promise<VerifyResult> {
	const [i, r, j, exp, kid, sig] = SIGNED_PARAMS.map((name) => params.get(name));
	if (i == null || r == null || j == null || exp == null || kid == null || sig == null) return { ok: false, reason: "malformed" };
	if (!INSTALLATION_ID.test(i) || r === "" || !isJobName(j) || !EXP.test(exp) || (kid !== "c" && kid !== "p")) {
		return { ok: false, reason: "malformed" };
	}
	const expSec = Number(exp);
	if (expSec > Math.floor(now.getTime() / 1000) + LOG_URL_TTL_SEC) return { ok: false, reason: "malformed" };

	const key = kid === "c" ? env.LOG_SIGNING_KEY : env.LOG_SIGNING_KEY_PREVIOUS;
	if (!key) return { ok: false, reason: "bad_signature" };
	const ref: LogRef = { installationId: Number(i), runId: r, job: j };
	if (!timingSafeEqual(base64url(await hmacSha256(key, signedData(ref, expSec))), sig)) return { ok: false, reason: "bad_signature" };

	if (expSec * 1000 <= now.getTime()) return { ok: false, reason: "expired" };
	return { ok: true, ref };
}
