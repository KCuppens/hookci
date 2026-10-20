# zerocideploy

CI and deploys that run on your own server, reported to GitHub and Slack, with zero CI config.

Status: pre-alpha, M0 (agent core).

## How it works

- The agent (`zeroci`) runs on your server. It detects what to check in your repository, runs each job in an isolated sandbox, and stores runs and logs locally.
- The hub at `ci.webuno.io` relays GitHub webhooks and Slack interactions to your agent and reports results back to GitHub and Slack.
- The agent dials out to the hub over a WebSocket. Your server needs no inbound ports.

M0 delivers the agent core only. The hub connection, GitHub reporting and Slack integration are planned for later milestones.

## Quick start (local)

Local mode needs no hub. Build the agent, then run it inside a repository:

```sh
make agent                 # builds dist/zeroci-<os>-<arch>
zeroci detect              # print the checks inferred for this repository
zeroci validate            # validate .zeroci.yml against the schema
zeroci run                 # run the checks locally
```

Commands available now: `version`, `detect`, `validate`, `init`, `run`, `status` and `logs`. Run `zeroci help` for the full list.

## Self-host the hub

The shared hub at `ci.webuno.io` is the quickest start. Self-host the hub when you want webhooks, tokens and run reports to stay in your own Cloudflare account, with your own GitHub App and Slack App and no per-installation quotas. The `zeroci-hub` CLI creates the Worker, D1 database, R2 bucket and both apps, and it can resume a setup that stopped.

You need Node.js 20+, a Cloudflare account, and a GitHub user or organization where you can create apps. A Slack workspace is optional.

```sh
npx wrangler login
npx zeroci-hub setup
sudo zeroci connect --hub <url> <pair-token>    # on your CI server, after installing the agent from <url>/install
```

Setup prints the GitHub App install link and the hub URL at the end. See [docs/self-host.md](docs/self-host.md) for each step, custom domains, upgrades, the trust policy, log retention, troubleshooting and uninstall.

## Repository layout

- `agent/`: Go agent and the `zeroci` CLI.
- `hub/`: Cloudflare Worker hub (`zeroci-hub`).
- `schema/`: JSON Schema for `.zeroci.yml` and the agent/hub protocol, source of generated Go and TypeScript types.
- `examples/`: example projects and detection fixtures.
- `scripts/`: `check.sh` and the schema codegen script.

## Development

- `make check` runs the schema fixture tests, the schema drift check, formatting, vet, unit tests, hub tests and a wrangler dry run. It must print `check: ok`.
- `make schema` regenerates Go and TypeScript types from `schema/zeroci.schema.json`. Run `cd schema && npm ci` once first.
- `make schema-check` fails if the committed generated types differ from what `make schema` would write.
- `make test-integration` runs the integration tests. They need root, so run them only on a throwaway VM, never on a workstation.

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and the sign-off rule ([DCO.md](DCO.md)).

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
