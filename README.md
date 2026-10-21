# hookci

CI and deploys that run on your own server, reported to GitHub and Slack, with zero CI config.

Status: pre-alpha, M0 (agent core).

## How it works

- The agent (`hookci`) runs on your server. It detects what to check in your repository, runs each job in an isolated sandbox, and stores runs and logs locally.
- The hub at `ci.webuno.io` relays GitHub webhooks and Slack interactions to your agent and reports results back to GitHub and Slack.
- The agent dials out to the hub over a WebSocket. Your server needs no inbound ports.

M0 delivers the agent core only. The hub connection, GitHub reporting and Slack integration are planned for later milestones.

## Quick start (local)

Local mode needs no hub. Build the agent, then run it inside a repository:

```sh
make agent                 # builds dist/hookci-<os>-<arch>
hookci detect              # print the checks inferred for this repository
hookci validate            # validate .hookci.yml against the schema
hookci run                 # run the checks locally
```

Commands available now: `version`, `detect`, `validate`, `init`, `run`, `status` and `logs`. Run `hookci help` for the full list.

Coming from ZeroCI (the earlier name of this project)? Old names keep working. See [MIGRATING.md](MIGRATING.md).

The hub also serves a read-only web dashboard of runs, logs and agents. See [docs/dashboard.md](docs/dashboard.md).

## Repository layout

- `agent/`: Go agent and the `hookci` CLI.
- `hub/`: Cloudflare Worker hub (`hookci-hub`).
- `schema/`: JSON Schema for `.hookci.yml` and the agent/hub protocol, source of generated Go and TypeScript types.
- `examples/`: example projects and detection fixtures.
- `scripts/`: `check.sh` and the schema codegen script.

## Development

- `make check` runs the schema fixture tests, the schema drift check, formatting, vet, unit tests, hub tests and a wrangler dry run. It must print `check: ok`.
- `make schema` regenerates Go and TypeScript types from `schema/hookci.schema.json`. Run `cd schema && npm ci` once first.
- `make schema-check` fails if the committed generated types differ from what `make schema` would write.
- `make test-integration` runs the integration tests. They need root, so run them only on a throwaway VM, never on a workstation.

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and the contributor license agreement ([CLA.md](CLA.md)).

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Licensed per directory: MIT for the agent and schema, AGPL-3.0 for the hub. See [LICENSING.md](LICENSING.md).
