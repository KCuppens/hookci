-- The checks run whose pass chained the deploy: its Slack message is the one
-- the deploy folds into, even when the same commit was pushed to other
-- branches. NULL for deploys chained before this column existed.
ALTER TABLE deploy_triggers ADD COLUMN checks_run_id TEXT;
CREATE INDEX deploy_triggers_installation_checks_run ON deploy_triggers (installation_id, checks_run_id);
