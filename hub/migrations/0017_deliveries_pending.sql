-- A delivery is recorded pending and marked processed only once its handler
-- finishes, so one whose handler was cut off can be claimed again. SQLite
-- cannot change a CHECK in place, so the table is rebuilt; no other table
-- references it.
CREATE TABLE deliveries_new (
	delivery_id TEXT PRIMARY KEY,
	received_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	event TEXT NOT NULL,
	installation_id INTEGER,
	status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'dropped', 'failed')),
	note TEXT
) STRICT;

INSERT INTO deliveries_new (delivery_id, received_at, expires_at, event, installation_id, status, note)
SELECT delivery_id, received_at, expires_at, event, installation_id, status, note FROM deliveries;

DROP TABLE deliveries;

ALTER TABLE deliveries_new RENAME TO deliveries;

CREATE INDEX deliveries_received_at ON deliveries (received_at);

-- Redeliveries the hub asked GitHub for, per delivery guid, so a delivery
-- whose handler always fails is sent again only a few times.
CREATE TABLE hook_redeliveries (
	guid TEXT PRIMARY KEY,
	attempts INTEGER NOT NULL,
	last_at INTEGER NOT NULL
) STRICT;
