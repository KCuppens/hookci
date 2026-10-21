import type { EmailBinding, EmailSender } from "./accounts/email";
import type { AgentDO } from "./do/agent";
import type { Clock } from "./do/clock";
import type { SlackWorkspaceDO } from "./do/slack-workspace";
import type { Fetcher } from "./http";

// Worker bindings. DB, LOGS, the Durable Objects and the vars come from
// wrangler.toml; everything else is a secret set with `wrangler secret put`.
export interface Env {
	DB: D1Database;
	LOGS: R2Bucket;
	AGENT_DO: DurableObjectNamespace<AgentDO>;
	SLACK_DO: DurableObjectNamespace<SlackWorkspaceDO>;
	HUB_ORIGIN: string;
	HUB_VERSION: string;
	/** Newest released agent version, e.g. v0.2.0; empty until the first release. */
	LATEST_AGENT_VERSION: string;
	/** Oldest agent version the hub serves; empty means no minimum. */
	MIN_AGENT_VERSION: string;
	/** The public GitHub App's URL slug: https://github.com/apps/<slug>. */
	GITHUB_APP_SLUG: string;
	/** RFC 9116 Expires for /.well-known/security.txt: an RFC 3339 time one year past the build date. */
	SECURITY_TXT_EXPIRES: string;
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GITHUB_WEBHOOK_SECRET: string;
	GITHUB_WEBHOOK_SECRET_PREVIOUS?: string;
	/** The Slack App's id, for the slack://app deep link to its App Home. */
	SLACK_APP_ID: string;
	SLACK_CLIENT_ID: string;
	SLACK_CLIENT_SECRET: string;
	SLACK_SIGNING_SECRET: string;
	SLACK_SIGNING_SECRET_PREVIOUS?: string;
	/** JSON `{"current":<version>,"keys":{"<version>":"<base64 32-byte key>"}}`; see parseEncKeys. */
	TOKEN_ENC_KEYS: string;
	STATE_SIGNING_KEY: string;
	/** JSON `{"<version>":"<base64 key>"}`; the highest version is current. */
	LOG_SIGNING_KEYS: string;
	ROTATION_IN_PROGRESS?: string;
	/** "true" turns on email and password accounts and Google sign-in (the /account routes); anything else leaves them off and the routes 404. */
	ACCOUNTS_ENABLED?: string;
	/** The sender address of account email; its domain must be onboarded to Cloudflare Email Service. */
	ACCOUNTS_MAIL_FROM?: string;
	/** Cloudflare Email Service send_email binding; account email is not sent without it. */
	EMAIL?: EmailBinding;
	/** Google OAuth client for "Continue with Google"; the button is hidden unless both are set. */
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	/** Tests only: replaces the wall clock. Never set in wrangler.toml. */
	__TEST_CLOCK?: Clock;
	/** Tests only: replaces fetch for GitHub and Slack calls. Never set in wrangler.toml. */
	__TEST_FETCHER?: Fetcher;
	/** Tests only: replaces the Cloudflare email binding. Never set in wrangler.toml. */
	__TEST_EMAIL?: EmailSender;
}
