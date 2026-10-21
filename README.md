# hookci

CI and deploys that run on your own server, reported to GitHub and Slack, with zero CI config.

Status: pre-alpha, M0 (agent core).

## How it works

- The agent (`hookci`) runs on your server. It detects what to check in your repository, runs each job in an isolated sandbox, and stores runs and logs locally.
- The hub at `ci.webuno.io` relays GitHub webhooks and Slack interactions to your agent and reports results back to GitHub and Slack.
- The agent dials out to the hub over a WebSocket. Your server needs no inbound ports.

M0 delivers the agent core only. The hub connection, GitHub reporting and Slack integration are planned for later milestones.

## Which pushes and pull requests run

Like a GitHub Actions workflow's `on:`, `.hookci.yml` picks the events. The hub reads it at the pushed commit (for a fork pull request, at the base commit) and drops events that do not match, so they get no check and no Slack message. A repo with no agent paired is judged by the defaults below without reading its file.

```yaml
checks:
  on:
    pull_request: true          # default: every pull request runs
    push:
      branches: [main, "release/**"]   # default: the default branch only
deployments:
  staging:
    on: { push: develop }       # a deploy branch always runs checks
```

`*` matches within one path segment, `**` across segments. A deployment ships only when its checks pass on a push to its `on.push` branch. Its `on.push` is read from the default branch's `.hookci.yml`, never from the pushed commit, so a branch cannot name itself a deploy branch. Each branch pushed keeps its own build cache and falls back to the default branch's. A branch that restores the fallback's cache does not save a copy of its own. A pull request reads its base branch's cache, then the default branch's, and never writes one.

## Quick start (local)

Local mode needs no hub. Build the agent, then run it inside a repository:

```sh
make agent                 # builds dist/hookci-<os>-<arch>
hookci detect              # print the checks inferred for this repository
hookci validate            # validate .hookci.yml against the schema
hookci run                 # run the checks locally
```

Commands available now: `version`, `detect`, `validate`, `init`, `run`, `status` and `logs`. Run `hookci help` for the full list.

## Self-host the hub

The shared hub at `ci.webuno.io` is the quickest start. Self-host the hub when you want webhooks, tokens and run reports to stay in your own Cloudflare account, with your own GitHub App and Slack App and no per-installation quotas. The `hookci-hub` CLI creates the Worker, D1 database, R2 bucket and both apps, and it can resume a setup that stopped.

You need Node.js 20+, a Cloudflare account, and a GitHub user or organization where you can create apps. A Slack workspace is optional.

```sh
npx wrangler login
npx hookci-hub setup
sudo hookci connect --hub <url> <pair-token>    # on your CI server, after installing the agent from <url>/install
```

Setup prints the GitHub App install link and the hub URL at the end. See [docs/self-host.md](docs/self-host.md) for each step, custom domains, upgrades, the trust policy, log retention, troubleshooting and uninstall.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and the sign-off rule ([DCO.md](DCO.md)).

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
