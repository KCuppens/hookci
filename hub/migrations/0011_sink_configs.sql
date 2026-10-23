-- Outbound sinks (Telegram chats, webhooks) an installation sends run updates
-- to, per repo. secret_enc is IV || AES-GCM ciphertext of the bot token or
-- signing secret under key_version, with `installation_id:id` as AAD; NULL
-- when the sink has no secret. A disabled sink stays for its owner to see.
CREATE TABLE sink_configs (
	installation_id INTEGER NOT NULL,
	id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('telegram', 'webhook')),
	repo TEXT NOT NULL,
	target TEXT NOT NULL,
	secret_enc BLOB,
	key_version INTEGER,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	disabled_at INTEGER,
	disabled_reason TEXT,
	PRIMARY KEY (installation_id, id)
) STRICT;

CREATE INDEX sink_configs_repo ON sink_configs (installation_id, repo);

-- The provider message each sink keeps updating for a run, and the hash of
-- what it last sent, so an unchanged view is not sent again.
CREATE TABLE sink_messages (
	installation_id INTEGER NOT NULL,
	sink_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	external_id TEXT,
	last_hash TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (installation_id, sink_id, run_id)
) STRICT;

-- Every delivery attempt; delivery_id stays the same across the retries of one
-- enqueued update.
CREATE TABLE sink_deliveries (
	installation_id INTEGER NOT NULL,
	sink_id TEXT NOT NULL,
	delivery_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('ok', 'retrying', 'failed', 'dropped')),
	http_status INTEGER,
	at INTEGER NOT NULL,
	PRIMARY KEY (installation_id, sink_id, delivery_id, attempt)
) STRICT;
