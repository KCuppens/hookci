# MCP server

The hub exposes a remote [MCP](https://modelcontextprotocol.io) server for run
and agent visibility, plus deploy-retry and run-cancel, so an AI agent or MCP
client can be pointed at your hub instead of (or alongside) the dashboard.

## Getting a token

Create an API token from the dashboard's installation settings page
(`/app/<installationId>/settings`, "API tokens"). The token is shown once, on
creation; the hub stores only its hash. It looks like `hci_mcp_...` and is
not tied to a GitHub user: anyone holding it has full read/write access
(including cancel and retry) to that one installation, with no further
permission check. Revoke a token from the same page the moment it may have
leaked.

## Endpoint

```
POST/GET/DELETE  https://<your-hub>/mcp
POST/GET/DELETE  https://<your-hub>/mcp/<token>
```

`/mcp` is the [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)
transport and expects the token as a bearer header:

```
Authorization: Bearer hci_mcp_...
```

`/mcp/<token>` is a path-based fallback with the same behavior, for clients
that cannot set a custom header. Point most MCP clients at `/mcp` with the
header; use the path form only when the client has no way to configure one.

Missing, malformed, unknown or revoked tokens get `401` with
`{"error":"auth_failed"}` and a `WWW-Authenticate: Bearer` header, before any
MCP protocol handling runs.

## Tools

Every tool is scoped to the token's installation; there is no cross-tenant
access and no `installation_id` argument. A tool never fails the MCP call for
a domain-level problem (a run that does not exist, a log not uploaded yet,
...): it returns `isError: true` with a small JSON payload describing why
instead of a protocol-level error.

### `list_runs`

List runs for this installation, newest first.

| arg | type | default | notes |
| --- | --- | --- | --- |
| `repo` | string | — | `owner/repo`; unknown repo returns `{"runs":[]}` |
| `state` | string | — | e.g. `running`, `success`, `failed`, `cancelled` |
| `limit` | number | `20` | 1-100 |
| `before` | number | — | a run's `run_rowid`; pages older runs. Only used when neither `repo` nor `state` is set |
| `offset` | number | `0` | rows to skip. Only used when `repo` or `state` is set |

Filtering by `repo` or `state` switches to offset pagination; with neither
filter, `before` pages by cursor instead. The two pagination styles are not
combined.

Returns `{"runs": [...]}`, each run shaped like:

```json
{
  "run_id": "01JB2Z5R0A1B2C3D4E5F6G7H8J",
  "run_rowid": 418,
  "run_number": 418,
  "repo": "acme/api",
  "ref": "refs/heads/main",
  "sha": "4f2a9c0e1d7b3a5c6e8f9a0b1c2d3e4f5a6b7c8d",
  "event": "push",
  "state": "success",
  "agent_name": "ci-1",
  "started_at": 1732104005000,
  "finished_at": 1732104041000,
  "duration_ms": 36000
}
```

### `get_run`

Get one run by id, with its jobs.

| arg | type |
| --- | --- |
| `run_id` | string, required |

Returns the same shape as a `list_runs` row plus `reason`, `author_login`,
`commit_title`, `trust_refused` and `jobs`, where each job is
`{name, state, step, step_index, steps_total, duration_ms}`. An unknown or
malformed `run_id` returns `{"error":"not_found"}` with `isError: true`.

### `get_run_logs`

Get one job's log text for a run.

| arg | type |
| --- | --- |
| `run_id` | string, required |
| `job` | string, required |

Returns `{"available": true, "text": "...", "truncated": false}`, or
`{"available": false}` if the agent has not uploaded the log yet. An unknown
run or job returns `{"error":"not_found"}` with `isError: true`. `truncated`
is `true` when the log was cut to the dashboard's render limit.

### `cancel_run`

Cancel a run that has not finished.

| arg | type |
| --- | --- |
| `run_id` | string, required |

Returns `{"run_id": "...", "outcome": "cancelled" | "cancelling" | "not_open"}`.
`isError` is `true` only for `not_open` (the run already finished, or was
never open). An unknown or malformed `run_id` returns `{"error":"not_found"}`.

### `retry_run`

Retry a finished run as a new attempt on its target repo and ref.

| arg | type |
| --- | --- |
| `run_id` | string, required |

Returns `{"run_id": "...", "kind": "retried" | "no_agent" | "fork_never" | "gated" | "duplicate" | "offline", ...}`
(additional fields depend on `kind`). `isError` is `true` for every `kind`
other than `retried`. An unknown `run_id` returns `{"error":"not_found"}`; a
run whose repo no longer exists returns `{"error":"repo_not_found"}`.

### `list_agents`

No arguments. Returns `{"agents": [...]}`, each agent shaped like:

```json
{
  "agent_id": "agt_1",
  "name": "ci-1",
  "hostname": "ci-1.local",
  "os": "linux",
  "os_release": "6.8.0",
  "arch": "amd64",
  "agent_version": "0.4.2",
  "status": "online",
  "last_seen_at": 1732104005000,
  "revoked_at": null,
  "budget_cpus": 4,
  "budget_memory_bytes": 8589934592
}
```

### `list_repositories`

No arguments. Returns `{"repositories": [{"repo_id": 711, "full_name": "acme/api", "default_branch": "main"}, ...]}`.
