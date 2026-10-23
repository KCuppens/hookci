-- The agent's operating system as it reported in its hello frame, for example "Ubuntu 22.04",
-- "macOS 14.5" or "Windows 11". Null until the agent says: agents that predate the field never do.
-- The hub keeps printable characters only and at most 64 of them.
ALTER TABLE agents ADD COLUMN os_release TEXT;
