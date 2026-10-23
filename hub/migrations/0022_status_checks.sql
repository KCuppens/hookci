-- Daily results of the hub's own health probes, for the public /status page.
-- The table is global: it belongs to no installation and holds no tenant data,
-- only counts per component and UTC day. The cron writes one row per component
-- and day and bumps it on every probe; rows older than the retention are pruned.

CREATE TABLE status_checks (
	component TEXT NOT NULL CHECK (component IN ('api', 'agents', 'logs')),
	-- UTC day, YYYY-MM-DD.
	day TEXT NOT NULL CHECK (length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	checks_ok INTEGER NOT NULL CHECK (checks_ok >= 0),
	checks_total INTEGER NOT NULL CHECK (checks_total > 0 AND checks_ok <= checks_total),
	-- The newest probe of the day: when it ran, whether it passed and how long it took.
	last_checked_at INTEGER NOT NULL CHECK (last_checked_at > 0),
	last_ok INTEGER NOT NULL CHECK (last_ok IN (0, 1)),
	last_latency_ms INTEGER NOT NULL CHECK (last_latency_ms >= 0),
	PRIMARY KEY (component, day)
) STRICT;
