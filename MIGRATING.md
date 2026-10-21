# Migrating from ZeroCI

hookci is the new name of ZeroCI. Everything that used the old name is renamed, and the old names are still accepted so existing installs and repositories keep working.

| What | New name | Old name, still accepted |
| --- | --- | --- |
| Binary | `hookci` | `zeroci` (the installer adds a symlink when it finds an old install) |
| Repo config | `.hookci.yml` | `.zeroci.yml` (a deprecation warning is logged; `.hookci.yml` wins if both exist) |
| Environment variables | `HOOKCI_*` | `ZEROCI_*` (read as a fallback) |
| Job environment | `HOOKCI`, `HOOKCI_SHA`, `HOOKCI_REF`, ... | the same `ZEROCI*` variables are still exported to jobs |
| State directory | `/var/lib/hookci` | `/var/lib/zeroci` is used when it exists and the new one does not; data is never moved |
| systemd unit | `hookci-agent@<installation-id>.service` | `zeroci-agent@<installation-id>.service` is used when it is the one installed |
| Slack command | `/hookci` | `/zeroci` |
| Pair tokens and credentials | `hc_pair_...`, `hc_agent_...` | `zc_pair_...`, `zc_agent_...` keep working |
| Hub headers | `x-hookci-*` | `x-zeroci-*` |

Not carried over: the web session and OAuth state cookies were renamed. Existing ones expire within 30 minutes, so you may be asked to sign in once more.

## Moving at your own pace

1. Rename `.zeroci.yml` to `.hookci.yml` in your repositories.
2. Change scripts that read `ZEROCI_*` to `HOOKCI_*`.
3. Optional: move the state directory and unit to the new names yourself (stop the unit, move `/var/lib/zeroci` to `/var/lib/hookci`, install and enable `hookci-agent@<id>`, disable the old unit).

The fallbacks exist for the transition and may be removed in a future major version.
