CREATE TABLE deploy_runs (
  run_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL, env TEXT NOT NULL, sha TEXT NOT NULL, ref TEXT NOT NULL,
  strategy TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  prev_color TEXT, target_color TEXT, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);
CREATE INDEX deploy_runs_repo_env ON deploy_runs(repo, env, created_at);

CREATE TABLE deploy_steps (
  run_id TEXT NOT NULL, step_index INTEGER NOT NULL,
  name TEXT NOT NULL, status TEXT NOT NULL,
  outputs TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER, finished_at INTEGER,
  PRIMARY KEY (run_id, step_index)
);

CREATE TABLE deploy_state (
  repo TEXT NOT NULL, env TEXT NOT NULL,
  active_color TEXT, last_success_sha TEXT, last_success_run TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, env)
);

CREATE TABLE port_allocations (
  repo TEXT NOT NULL, env TEXT NOT NULL, color TEXT NOT NULL,
  port INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (repo, env, color)
);

CREATE TABLE env_locks (
  repo TEXT NOT NULL, env TEXT NOT NULL,
  run_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (repo, env)
);
