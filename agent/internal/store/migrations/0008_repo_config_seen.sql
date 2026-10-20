CREATE TABLE repo_config_seen (repo TEXT PRIMARY KEY, sha TEXT NOT NULL, trust TEXT NOT NULL, has_deployments INTEGER NOT NULL, seen_at INTEGER NOT NULL);
