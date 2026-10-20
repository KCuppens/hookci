import type { AgentDO } from "./do/agent";
import type { Clock } from "./do/clock";
import type { SinkOutboxDO } from "./do/sink-outbox";
import type { SlackWorkspaceDO } from "./do/slack-workspace";
import type { Fetcher } from "./http";

// Worker bindings. DB, LOGS, the Durable Objects and the vars come from
// wrangler.toml; everything else is a secret set with `wrangler secret put`.
export interface Env {
	DB: D1Database;
	LOGS: R2Bucket;
	AGENT_DO: DurableObjectNamespace<AgentDO>;
	SLACK_DO: DurableObjectNamespace<SlackWorkspaceDO>;
	SINK_OUTBOX: DurableObjectNamespace<SinkOutboxDO>;
	HUB_ORIGIN: string;
	HUB_VERSION: string;
	/** Newest released agent version, e.g. v0.2.0; empty until the first release. */
	LATEST_AGENT_VERSION: string;
	/** Oldest agent version the hub serves; empty means no minimum. */
	MIN_AGENT_VERSION: string;
	/** The public GitHub App's URL slug: https://github.com/apps/<slug>. */
	GITHUB_APP_SLUG: string;
	/** security.txt Contact, a mailto: or https: URI; empty points reporters at GitHub's private advisories. */
	SECURITY_CONTACT: string;
	/** "shared" (default) or "self_hosted"; anything else is treated as shared. */
	HUB_MODE?: string;
	/** The Telegram Bot API origin, https://api.telegram.org; tests point it at a fake. */
	TELEGRAM_API_BASE: string;
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
	/** HMAC key of signed log links, kid=c; LOG_SIGNING_KEY_PREVIOUS (kid=p) still verifies during a rotation. */
	LOG_SIGNING_KEY: string;
	LOG_SIGNING_KEY_PREVIOUS?: string;
	ROTATION_IN_PROGRESS?: string;
	/** Tests only: replaces the wall clock. Never set in wrangler.toml. */
	__TEST_CLOCK?: Clock;
	/** Tests only: replaces fetch for GitHub, Slack and Telegram calls. Never set in wrangler.toml. */
	__TEST_FETCHER?: Fetcher;
}
