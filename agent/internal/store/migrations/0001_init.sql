CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL, sha TEXT NOT NULL, ref TEXT NOT NULL,
  event TEXT NOT NULL,
  pr INTEGER NULL, base_sha TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL CHECK (kind IN ('check','deploy')),
  env TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  trust_domain TEXT NOT NULL,
  trigger_id TEXT NOT NULL DEFAULT '',
  retry_of TEXT NULL REFERENCES runs(id),
  created_at TEXT NOT NULL, started_at TEXT NULL, finished_at TEXT NULL,
  reason TEXT NOT NULL DEFAULT '', step_index INTEGER NOT NULL DEFAULT 0,
  UNIQUE (repo, sha, event, env, attempt)
);
CREATE INDEX runs_state ON runs(state);
CREATE INDEX runs_created ON runs(created_at);

CREATE TABLE jobs (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, state TEXT NOT NULL, needs TEXT NOT NULL DEFAULT '[]',
  exit_code INTEGER NULL, started_at TEXT NULL, finished_at TEXT NULL,
  duration_ms INTEGER NULL, unit TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, name)
);

CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload BLOB NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE hwm (direction TEXT PRIMARY KEY CHECK (direction IN ('in','out_acked')), seq INTEGER NOT NULL);
