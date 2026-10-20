-- Why a gated fork run's base ref asked for `trust: all` and the hub refused
-- it: shared_hub (the shared hub never honors it) or deploy_bindings (a
-- self-hosted repo that deploys). The zeroci check summary says so. NULL when
-- nothing was refused, including every run before this migration.
ALTER TABLE runs ADD COLUMN trust_refused TEXT CHECK (trust_refused IN ('shared_hub', 'deploy_bindings'));
