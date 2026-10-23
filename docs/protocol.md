# Agent protocol notes

The agent and the hub talk over a WebSocket with the frames defined in `schema/hookci.schema.json`. This page covers three additions. All follow the same rule: a new field is optional, an agent that does not send it keeps working, and a hub that does not know it ignores it.

## `os_release` in hello

The agent may add `os_release` to its `hello` frame: a short, human readable description of the operating system, such as `Ubuntu 22.04`, `Debian GNU/Linux 12`, `macOS 14.5` or `Windows 11`.

How the agent finds it:

- **Linux.** `PRETTY_NAME` from `/etc/os-release`, else `NAME` (or `ID`) plus `VERSION_ID`. A trailing `LTS` and the patch version are dropped, so `Ubuntu 22.04.4 LTS` becomes `Ubuntu 22.04`.
- **macOS.** `sw_vers`, as `macOS <major>.<minor>`.
- **Windows.** `ver`: `Windows 11` from build 22000, `Windows 10` before it.
- Anything else, or a failed lookup, sends no `os_release`.

The agent keeps printable characters only and at most 64 of them. The hub does the same again on arrival: it removes control, format and separator characters, collapses white space, cuts the text to 64 characters and treats an empty result as not reported.

The hub stores the value in the nullable `agents.os_release` column, updated on every hello that carries one. A hello without it leaves the stored value alone, so an older agent shows nothing until it first reports. The Agents queries return it as `os_release` (`AgentRow` and `AgentListRow`).

## Stored annotations

An agent sends `annotations` frames with the file annotations it parsed from a job's output. The hub posts them to the GitHub check run as before and now also stores them in the `annotations` table for the run page.

- **Limits.** At most 50 rows per job and 200 per run. Items past a limit are not stored (GitHub still gets them). The hub cuts a path to 512 characters, a title to 255 and a message to 2000. An item with an empty path, a line below 1 or above 10 million, an unknown level or a non-string message is dropped without failing the frame.
- **Scope.** A row belongs to the installation of the agent that sent it. A frame for a run of another installation, or for a run the agent does not own, stores nothing.
- **Order.** The run page lists failures first, then warnings, then notices, each by path and line.
- **Retention.** Rows are deleted with their run: by the retention purge after 14 days and when an installation is deleted.
- **Fields.** The frame's `line` becomes both `start_line` and `end_line`. `column` is not stored. `title` is optional.

## The `setup` job

The agent reports a run's setup (checkout, config, network, cache restore, Postgres and the `setup` steps) as a job named `setup`, with no new frame type and no schema change.

- **Planned first.** `job_planned` lists `setup` before the config's jobs, and every job that had no `needs` now needs `setup`. The hub stores jobs in the order planned, so the run page shows setup first.
- **States.** `job` events with `job: "setup"` move it through `queued`, `running`, then `success`, `failed` or `cancelled`, with `duration_ms`. While it runs, events carry `step`, `step_index` and `steps_total`; the hub shows them inside the row. A `failed` event carries a `reason` and a `tail`. The agent uploads `logs/setup.log` for the job, or sends `logs: "local"` when it cannot.
- **Gating.** No other job starts until setup succeeds. When setup fails, every other job is `skipped` with the reason `needs setup failed` and the run ends `failed` with the reason `setup failed: <error>`.
- **Checks and counts.** The hub treats `setup` as any job: a check run `hookci/setup`, a row in the Slack and Telegram job counts, and one of the "Jobs N of M" on the run page. It counts against the 200 jobs a run may have. The configuration card's "N jobs detected" does not count it.
- **Reserved name.** A config cannot define a job named `setup`.
- **Runs without it.** A retry of a run planned by an older agent has no `setup` job. For it the agent keeps sending run-level `running` events with `step`, `step_index` and `steps_total`, and the hub keeps showing the "Setting up" banner. The hub shows that banner only when the run has no `setup` job.

## Compatibility

- **Old agent, new hub.** The agent sends no `os_release`; the hub shows none. Annotations frames are unchanged and stored.
- **New agent, old hub.** The hello carries an extra `os_release` property. The hub only checks the frame version, the type and the required keys, so it ignores the property and the connection works. The schema marks `Hello` with `additionalProperties: false`, but only the schema tests and tools that validate against it enforce that; neither side of the protocol validates incoming frames against the schema at run time. An old hub that does validate (a third party implementation) would reject the hello, so such an implementation must be updated before the agent is.
- **Migrations.** `0023_annotations.sql` creates the `annotations` table and `0028_agent_os_release.sql` adds `agents.os_release`. Apply them before the new hub code runs.
- **Setup job, new agent and old hub.** The hub sees one more job named `setup` and job-scoped step events, both of which it already handles. `protocol_version` stays 1: no frame or field changed. An old hub shows no banner for such a run, and counts the setup job in its job totals.
- **Setup job, old agent and new hub.** No `setup` job is planned, so the hub shows the run-level banner as before.
