-- When the repository was bound to its agent (epoch ms); null for bindings made before this column existed.
ALTER TABLE repo_bindings ADD COLUMN bound_at INTEGER;
