import type { Context } from "hono";
import type { Env } from "../env";
import { S } from "../strings";

/** RFC 9116 security.txt; Expires comes from SECURITY_TXT_EXPIRES, set one year past the build date. */
export function securityTxt(c: Context<{ Bindings: Env }>): Response {
	const body = [
		"Contact: mailto:security@webuno.io",
		`Expires: ${c.env.SECURITY_TXT_EXPIRES}`,
		`Policy: ${S.pages.securityPolicyUrl}`,
		"Preferred-Languages: en",
		"",
	].join("\n");
	return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}
