# Licensing

This repository is licensed per directory.

| Path | License |
| --- | --- |
| `hub/` | GNU Affero General Public License v3.0 (see `hub/LICENSE`) |
| Everything else (`agent/`, `schema/`, `packaging/`, `examples/`, `scripts/`, `docs/`, `graft/`) | MIT (see `LICENSE`) |

## What this means in practice

- **Running hookci on your own servers** for your own team is free under both licenses. You do not have to publish anything.
- **The agent and the schema** are MIT. You can embed, fork and redistribute them, including in closed products.
- **The hub** is AGPL-3.0. If you modify the hub and let other people use it over a network, you must offer those users the source of your modified version under the same license. Running an unmodified hub needs nothing.
- **The schema is the protocol contract.** Writing your own agent or hub against it does not make your code a derivative of the hub.

The hosted service at hookci.com adds closed components (the Slack and GitHub app registrations and their secrets, billing and other hosted-only features) that are not part of this repository.

Contributions are accepted under [CLA.md](CLA.md).
