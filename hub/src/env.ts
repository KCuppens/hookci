import type { AgentDO } from "./do/agent";
import type { Clock } from "./do/clock";
import type { Fetcher } from "./http";

// Worker bindings. DB, LOGS, the Durable Objects and the vars come from
// wrangler.toml; everything else is a secret set with `wrangler secret put`.
export interface Env {
	DB: D1Database;
	LOGS: R2Bucket;
	AGENT_DO: DurableObjectNamespace<AgentDO>;
	SLACK_DO: DurableObjectNamespace;
	HUB_ORIGIN: string;
	HUB_VERSION: string;
	/** The public GitHub App's URL slug: https://github.com/apps/<slug>. */
	GITHUB_APP_SLUG: string;
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GITHUB_WEBHOOK_SECRET: string;
	GITHUB_WEBHOOK_SECRET_PREVIOUS?: string;
	SLACK_CLIENT_ID: string;
	SLACK_CLIENT_SECRET: string;
	SLACK_SIGNING_SECRET: string;
	SLACK_SIGNING_SECRET_PREVIOUS?: string;
	/** JSON `{"<version>":"<base64 key>"}`; the highest version is current. */
	TOKEN_ENC_KEYS: string;
	STATE_SIGNING_KEY: string;
	/** JSON `{"<version>":"<base64 key>"}`; the highest version is current. */
	LOG_SIGNING_KEYS: string;
	ROTATION_IN_PROGRESS?: string;
	/** Tests only: replaces the wall clock. Never set in wrangler.toml. */
	__TEST_CLOCK?: Clock;
	/** Tests only: replaces fetch for GitHub calls. Never set in wrangler.toml. */
	__TEST_FETCHER?: Fetcher;
}
