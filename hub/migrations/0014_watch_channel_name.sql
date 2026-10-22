-- The Slack channel's name when it was watched, for the dashboard's Repositories tab. NULL for a watch made
-- before this column existed and for a direct message; the tab then shows the channel id.
ALTER TABLE watches ADD COLUMN channel_name TEXT;
