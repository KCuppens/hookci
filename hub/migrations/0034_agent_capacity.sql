-- Compute budget of an agent. budget_cpus and budget_memory_bytes are the override an administrator
-- set on the dashboard (null = the agent decides: its flags, environment or default of every CPU and no memory budget).
-- host_cpus and host_memory_bytes are the host size the agent reported; last_capacity is its latest
-- capacity frame as JSON (budget, granted and reserved amounts, pressure, running jobs) and
-- last_capacity_at the epoch ms it was stored. All are null for agents that predate the feature.
ALTER TABLE agents ADD COLUMN budget_cpus REAL;
ALTER TABLE agents ADD COLUMN budget_memory_bytes INTEGER;
ALTER TABLE agents ADD COLUMN host_cpus REAL;
ALTER TABLE agents ADD COLUMN host_memory_bytes INTEGER;
ALTER TABLE agents ADD COLUMN last_capacity TEXT;
ALTER TABLE agents ADD COLUMN last_capacity_at INTEGER;
