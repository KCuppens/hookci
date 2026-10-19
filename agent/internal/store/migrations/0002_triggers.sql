CREATE TABLE triggers (trigger_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX triggers_state ON triggers(state);
