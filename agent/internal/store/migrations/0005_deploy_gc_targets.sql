CREATE TABLE deploy_gc_targets (
  repo TEXT NOT NULL, env TEXT NOT NULL,
  project TEXT NOT NULL,
  retain_images INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, env)
);
