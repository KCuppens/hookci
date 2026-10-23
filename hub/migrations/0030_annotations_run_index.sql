-- Lookups and deletes by run alone (purging a run's annotations) cannot use the
-- (installation_id, run_id, job) index, which leads with the installation.

CREATE INDEX annotations_run_id ON annotations (run_id);
