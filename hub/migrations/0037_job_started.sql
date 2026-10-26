-- When a job left the queue (epoch ms), so the run page can count a running job's duration up.
ALTER TABLE jobs ADD COLUMN started_at INTEGER;
