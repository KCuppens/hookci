# Self-host the hub

This guide stands up your own hookci hub on your Cloudflare account and pairs an agent with it. The `hookci-hub` CLI does the work. You answer a few prompts and create a GitHub App and a Slack App in the browser.

## What you get

- Your own Worker running the hub, with its own D1 database, R2 log bucket and Durable Objects, all in your Cloudflare account.
- Your own GitHub App and Slack App. Webhooks, tokens and run reports never pass through the shared hub at `ci.hookci.com`.
- No per-installation quotas. The caps the shared hub sets on runs per day, agents per installation, pair tokens per hour, Slack commands per minute and sink changes per hour are lifted. The 10 MiB log size limit still applies, to protect your R2 bucket.
- Logs kept 14 days, then deleted.

## Prerequisites

- A Cloudflare account. The hub uses Workers, D1, R2, SQLite-backed Durable Objects and cron triggers. Which of these need the Workers Paid plan changes over time. Check Cloudflare's current pricing page before you start: https://developers.cloudflare.com/workers/platform/pricing/
- Node.js 20 or newer, with `npx`. Setup stops with `node_too_old` on an older Node.
- `npx wrangler login` done on the machine where you run setup. Setting `CLOUDFLARE_API_TOKEN` works too.
- A GitHub user or organization where you can create GitHub Apps.
- A Slack workspace where you can create apps. This is optional: `--no-slack` skips Slack, and a later setup run adds it.
- A browser on the same machine as setup. The GitHub App step serves a page on `127.0.0.1`, so run setup on your laptop, not over SSH on a server.

## Setup in 15 minutes

Run setup in an empty directory:

```sh
npx hookci-hub setup
```

Setup keeps its state in `./hookci-hub` (change it with `--dir <path>`). The state file `hookci-hub.state.json` holds resource ids and the steps done, never secret values. Each finished step is saved at once. If setup stops, fix the cause and run the same command again: finished steps print `done earlier` and are skipped.

Options for `setup`:

| Option | Effect |
| --- | --- |
| `--dir <path>` | State directory (default: `./hookci-hub`) |
| `--yes` | Answer yes to every confirmation and take the defaults: hub name `hookci-hub`, no custom domain |
| `--org <login>` | Create the GitHub App under this organization instead of your user |
| `--no-slack` | Skip the Slack App; a later setup run adds it |
| `--force-render` | Render wrangler.toml and deploy again even if done |
| `-h`, `--help` | Show help |

Setup runs twelve steps and prints each one as `[n/12] <label>`. The times are rough.

1. `preflight`, "Checking Node.js and the wrangler login". Checks Node.js 20+ and runs `wrangler whoami`. A few seconds.
2. `account`, "Choosing the Cloudflare account and hub name". Picks the Cloudflare account (it asks when wrangler can use more than one; `CLOUDFLARE_ACCOUNT_ID` skips the question). Asks `Hub name` (default `hookci-hub`) and `Custom domain (empty for workers.dev)`. The hub name is the Worker name and the prefix of the database and bucket names. Under a minute.
3. `d1`, "Creating the D1 database". Creates `<name>-db`, or reuses it if it exists. A few seconds.
4. `r2`, "Creating the R2 log bucket". Creates `<name>-logs`, or reuses it. A few seconds.
5. `r2_lifecycle`, "Adding the 14-day log retention rule". Adds the R2 lifecycle rule `hookci-log-retention`. A few seconds.
6. `render`, "Writing wrangler.toml and the Worker bundle". Copies the prebuilt Worker and the D1 migrations into the state dir and writes `wrangler.toml`. Under a second.
7. `migrate`, "Applying D1 migrations". Runs `wrangler d1 migrations apply <name>-db --remote`. Under a minute.
8. `deploy`, "Deploying the Worker". Runs `wrangler deploy` and records the hub URL. On a workers.dev hub, the first deploy learns the URL, so setup renders again and deploys a second time. About a minute.
9. `secrets`, "Storing generated Worker secrets". Generates and stores `TOKEN_ENC_KEYS`, `STATE_SIGNING_KEY` and `LOG_SIGNING_KEY` with `wrangler secret put`. Values travel on stdin and are never written to disk. About 30 seconds.
10. `github_app`, "Registering the hub's GitHub App". See below. One to three minutes.
11. `slack_app`, "Connecting the hub's Slack App". See below. Two to four minutes.
12. `verify`, "Checking the deployed hub". Reads `<hub>/v1/info` and checks the hub reports self-hosted mode and your GitHub App. It prints `The hub at <hub> answers as version <version>`. Up to about 10 seconds.

### The GitHub App page

Setup prints:

```
Open http://127.0.0.1:<port>/ in your browser to create the GitHub App
```

Open that URL. The page sends the hub's app manifest to GitHub (to your organization's settings with `--org`). Check the app name and click the create button on GitHub. GitHub sends the browser back to setup, which shows `GitHub App created. Return to the terminal.` You have 10 minutes.

Setup then stores the app's credentials as Worker secrets (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`), deploys again with the app's slug and prints:

```
Install the app: https://github.com/apps/<slug>/installations/new
```

### The Slack App

Setup prints a `Create the Slack App: https://api.slack.com/apps?new_app=1&manifest_json=...` link and:

```
Create the app from the manifest, choose the workspace, then open Basic Information and copy its App Credentials here.
```

Open the link, create the app from the manifest, and choose your workspace. On the app's Basic Information page, under App Credentials, copy these three values when setup asks:

1. `Slack Signing Secret` (hidden input). Stored as `SLACK_SIGNING_SECRET`.
2. `Slack Client ID`, shaped like `1234567890.1234567890`. Stored as `SLACK_CLIENT_ID`.
3. `Slack Client Secret` (hidden input). Stored as `SLACK_CLIENT_SECRET`.

Each prompt allows three tries. Setup then prints `Add to Slack: <hub>/slack/install`.

With `--no-slack`, setup prints `Skipping Slack (--no-slack). Run hookci-hub setup again later to add it.`

### The final summary

Setup ends with what to do next, also when every step was done earlier:

```
Hub: https://<your-hub>
Install the GitHub App: https://github.com/apps/<slug>/installations/new
Add to Slack: https://<your-hub>/slack/install
Pair an agent with the pair token shown after the GitHub App install or in Slack App Home:
  curl -fsSL https://<your-hub>/install | sh
  hookci connect --hub https://<your-hub> <pair-token>
Upgrade later with: npx hookci-hub upgrade
```

Keep the state directory. Upgrades and reruns need it.

### Rotating the log signing key

`LOG_SIGNING_KEY` signs log links. During a rotation, the hub also accepts links signed with `LOG_SIGNING_KEY_PREVIOUS`. Put the old value as `LOG_SIGNING_KEY_PREVIOUS` and a new value as `LOG_SIGNING_KEY` with `npx wrangler secret put <NAME>` in the state dir. Setup does not keep secret values, so you need your own copy of the old key to keep old links working.

The hub refuses to sign or check log links and sign-in sessions while `LOG_SIGNING_KEY` is unset or empty. It replaced the m2 JSON secret `LOG_SIGNING_KEYS`. Operators of the shared hub and staging must put `LOG_SIGNING_KEY` with `npx wrangler secret put LOG_SIGNING_KEY` before deploying this release.

## Install the GitHub App and pair an agent

1. Open the install link from the summary, `https://github.com/apps/<slug>/installations/new`, and choose the repositories.
2. Get a pair token. It is shown after the GitHub App install, and in the hub's Slack App Home.
3. On the server that runs your CI, install the agent from your hub and pair it:

```sh
curl -fsSL https://<your-hub>/install | sh -s -- <pair-token>
hookci doctor
```

The installer needs `curl`, and `cosign` to check the release signature. Without cosign it stops; set `HOOKCI_ALLOW_UNSIGNED=1` (`curl -fsSL https://<your-hub>/install | HOOKCI_ALLOW_UNSIGNED=1 sh -s -- <pair-token>`) to install with only the checksum checked. With a pair token it runs `sudo hookci connect --hub https://<your-hub> <pair-token>` after the install. Without one it only installs, and you pair later with that command.

`hookci connect` stores the agent credential under `/var/lib/hookci/<installation_id>` and enables the `hookci-agent@<installation_id>` systemd unit, so it runs as root. Without `--hub` the agent pairs with `HOOKCI_HUB_URL` if set, else the shared hub. A pair token works once. `hookci doctor` checks the agent and its hub connection, and prints a fix for each problem.

The agent runs one trigger at a time per lane, a lane being the pushes of one branch or one pull request, and lanes side by side. Each setup and job waits until the budget has room for its CPU and memory limits: `--cpu-budget CORES` (default: every CPU) and `--mem-budget SIZE`, for example `32G` (default: no memory budget). It also waits while the host has less than 4G free past its memory limit, or its load average is at the CPU count. One setup or job always runs when nothing else does. Set the flags after `agent` in a drop-in, `systemctl edit hookci-agent@<installation_id>`:

```ini
[Service]
ExecStart=
ExecStart=/usr/local/bin/hookci agent --installation %i --cpu-budget 6 --mem-budget 32G
```

The agent can run the hub CLI for you on a machine with Node.js 20+ and npx: `hookci hub setup` and `hookci hub upgrade` run `npx --yes hookci-hub@<agent version> setup` or `upgrade` (`hookci-hub@latest` for a dev build), and pass every later argument to `hookci-hub`.

## Custom domain

By default the hub runs on `https://<name>.<subdomain>.workers.dev`. To use your own domain, answer the `Custom domain (empty for workers.dev)` prompt in the `account` step, for example `ci.example.com`. The domain must be in a zone on the same Cloudflare account. `--yes` skips this prompt and uses workers.dev.

Setup renders the domain as a Workers Custom Domain route in `wrangler.toml`:

```toml
routes = [{ pattern = "ci.example.com", custom_domain = true }]
```

The hub URL, the GitHub App and the Slack App all use the domain. Do not edit `wrangler.toml` by hand to add a route: `hookci-hub upgrade` renders it again from the state and your edit is lost.

To move an existing hub to a domain, set `"custom_domain": "ci.example.com"` in `hookci-hub/hookci-hub.state.json`, then run `npx hookci-hub setup --force-render`. This renders and deploys again with the new URL. The GitHub App and Slack App keep their old URLs, so change every URL that starts with the old hub URL in the GitHub App settings and the Slack App settings. Pair agents again with `sudo hookci connect --hub https://ci.example.com --force <pair-token>`.

## Upgrading

Run from the directory that holds the state dir, with a newer `hookci-hub`:

```sh
npx hookci-hub upgrade --dry-run
npx hookci-hub upgrade
```

Or from a server with the agent: `hookci hub upgrade`, which runs the `hookci-hub` of the agent's version.

Upgrade prints its plan first:

```
Upgrading <name> at https://<your-hub> from <old> to <new>
D1 migrations to apply: <names, or none>
wrangler.toml: <changes, or unchanged>
```

With `--dry-run` it stops there and prints `Dry run: nothing changed.` Otherwise it asks `Upgrade <name> to <new>?` (`--yes` answers yes). It then renders `wrangler.toml` and the Worker bundle, applies pending D1 migrations, deploys, checks that `/v1/info` reports the new version, and prints `Upgraded <name> to <new>`.

Options for `upgrade`: `--dir <path>`, `--yes`, `--dry-run`.

D1 migrations only move forward. There is no downgrade: a `hookci-hub` older than the deployed hub stops with `downgrade` and changes nothing.

## Trust policy on self-hosted hubs

`checks.trust` in `.hookci.yml` decides who may run without approval. The hub reads it from the base branch, never from the pull request head.

```yaml
checks:
  trust: all
```

`trust: all` lets fork pull requests run without approval. The hub honors it only on a self-hosted hub, and only when the repository has no deploy bindings. Otherwise the hub uses `collaborators` and reports why:

- On the shared hub: "trust: all is not allowed on the shared hub. Fork PRs need approval."
- On a self-hosted hub, for a repository with deploy bindings: "trust: all is ignored because this repo has deploy bindings. Fork PRs need approval."

Only use `trust: all` when anyone who can open a pull request may run code on your agent's server.

## Log retention

Job logs are kept 14 days.

- The `r2_lifecycle` setup step adds the R2 lifecycle rule `hookci-log-retention`. It expires objects under `logs/` in `<name>-logs` 14 days after upload.
- A daily cron backstop (`17 3 * * *`, UTC) deletes log objects older than 14 days that the rule has not removed yet. It works through a large bucket in slices over several days.
- A log link for an expired log shows `Log expired (14-day retention) or kept local on the agent.`

## Email accounts (optional)

By default the hub's dashboard signs people in with GitHub only. A hub can also offer email and password accounts, Google sign-in and emailed password reset. The feature is off until you turn it on; while it is off, every `/account/...` path answers the standard 404 and the hub behaves as before.

1. **Turn it on.** Set `ACCOUNTS_ENABLED = "true"` in `[vars]` of `hub/wrangler.toml` (the default is `"false"`), and apply D1 migration `0021_accounts.sql` with the other migrations.
2. **Mail.** Verification and reset links go out through Cloudflare Email Service. The `send_email` binding named `EMAIL` is already declared in `wrangler.toml`. Set `ACCOUNTS_MAIL_FROM` in `[vars]` to a sender address such as `HookCI <no-reply@mail.example.com>` (or a bare address). Onboard that domain in the Cloudflare dashboard under Email Service and add the DNS records it asks for: SPF and DKIM at least, DMARC recommended. Until the sender is set and the domain is verified, the hub logs a failed send (never the address) and shows the same "check your email" page, so nobody can tell whether an address has an account.
3. **Google sign-in (optional).** In Google Cloud Console create an OAuth client of type "Web application" and add this authorized redirect URI, with your own hub origin:

   ```
   <HUB_ORIGIN>/account/google/callback
   ```

   For the shared hub that is `https://ci.hookci.com/account/google/callback`. Then store the client with `wrangler secret put GOOGLE_CLIENT_ID` and `wrangler secret put GOOGLE_CLIENT_SECRET`. The Google button shows only when both secrets are set. Only Google addresses marked `email_verified` are accepted.

An account proves who a person is, not what they may see. A browser signed in with email or Google sees no runs until the person also connects GitHub (the sign-in page leads them there). What they can open is decided by what GitHub says that user can access, never by their email address.

Signed-in people can sign out, open a small settings page (`/account/settings`) and delete their own account (`/account/delete`) from the dashboard header. The emailed verification link only opens a confirmation page, so a mail scanner that fetches the link cannot use it up; the address is verified when the person presses the button. The dashboard, its sessions and the 404 rules are described in [dashboard.md](dashboard.md).

## Troubleshooting

`hookci-hub` prints errors as:

```
hookci-hub: <message>
  <last lines wrangler printed, if any>
hint: <what to do>
```

It exits 1 on an error and 2 on a usage error. Setup saves each finished step, so after a fix, run the same command again.

### `node_too_old`

Cause: Node.js is older than 20 (`hookci-hub needs Node.js 20 or newer, this is <version>`).
Fix: install Node.js 20 or newer, then run `npx hookci-hub setup` again.

### `not_logged_in`

Cause: `wrangler whoami` reports you are not authenticated and `CLOUDFLARE_API_TOKEN` is not set.
Fix: run `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN`, then run setup again.

### `multiple_accounts`

Cause: wrangler can use more than one Cloudflare account and setup could not tell which one. With `--yes` it does not ask. Without it, three answers did not match an account.
Fix: set `CLOUDFLARE_ACCOUNT_ID` to the account to use, or run without `--yes` and pick one by number or id.

### `wrangler_failed`

Cause: a wrangler command exited non-zero, for example because R2 is not enabled on the account or a name is taken. The message names the command and the lines below it are wrangler's output.
Fix: fix the cause shown, then run the same command again. Finished steps are skipped.

### `parse_failed`

Cause: wrangler printed something setup could not read, such as no account, no `database_id` or no workers.dev URL.
Fix: run setup again. If it fails the same way, report it with the wrangler output.

### `bad_name`

Cause: the hub name does not match the rules, or the state file has no hub name.
Fix: use 3 to 41 lowercase letters, digits or dashes, starting with a letter.

### `manifest_timeout`

Cause: no GitHub App was created within 10 minutes of setup printing the `127.0.0.1` URL.
Fix: run setup again and create the GitHub App in the browser within 10 minutes.

### `manifest_conversion_failed`

Cause: GitHub refused to turn the manifest code into app credentials, or its answer lacked a field. The code works once and expires after an hour.
Fix: run setup again.

### `github_app_verify_failed`

Cause: signing in as the new GitHub App failed, or GitHub reported a different app id or slug.
Fix: delete the new app in GitHub settings, remove `github_app_id` from `hookci-hub.state.json` in the state dir, then run setup again.

### `github_app_incomplete`

Cause: an earlier setup run created the GitHub App named in the message but failed before it stored all of the app's credentials as Worker secrets. GitHub hands out those credentials only once, and setup never writes them to disk, so it cannot finish that app. A run that fails after storing all of them, for example at the redeploy, does not hit this: the next run resumes at the redeploy with the same app.
Fix: delete that app on its settings page (the URL in the message), remove `github_app_id` from `hookci-hub.state.json` in the state dir, then run setup again. It creates a new app.

### `not_set_up`

Cause: `upgrade` found no setup state in the state dir, or setup has not deployed the hub yet.
Fix: run `npx hookci-hub setup` first, or pass the right `--dir`.

### `downgrade`

Cause: the deployed hub is newer than this `hookci-hub`.
Fix: run a `hookci-hub` as new as the hub or newer. D1 migrations only move forward.

### `version_mismatch`

Cause: after the upgrade deploy, `/v1/info` failed or reported a version other than the new one.
Fix: check `npx wrangler deployments list` in the state dir, then run `npx hookci-hub upgrade` again.

### `bad_manifest`

Cause: the packaged Slack manifest asks for other bot scopes than the hub uses. The package is damaged or mismatched.
Fix: reinstall `hookci-hub`.

### `missing_input`

Cause: a Slack value was empty or malformed three times.
Fix: copy the value from the Slack App's Basic Information page, then run setup again.

### `verify_failed`

Cause: `<hub>/v1/info` did not answer after 5 tries, or it did not report self-hosted mode, your GitHub App or a version.
Fix: check `npx wrangler deployments list` in the state dir, then run setup again. Finished steps are skipped.

## Uninstall

Run these in the state dir (`cd hookci-hub`), with `<name>` your hub name (default `hookci-hub`):

```sh
npx wrangler delete <name>
npx wrangler d1 delete <name>-db
npx wrangler r2 bucket delete <name>-logs
```

Deleting the Worker also removes its secrets, cron triggers and routes. R2 deletes only empty buckets: delete the objects in the Cloudflare dashboard first, or wait for the 14-day lifecycle rule to expire the logs.

Then delete the apps:

- GitHub App: your user's or organization's Settings, Developer settings, GitHub Apps, the app, Advanced, Delete GitHub App.
- Slack App: https://api.slack.com/apps, the app, Basic Information, Delete App.

Last, remove the local state dir (`hookci-hub`) and stop the agents paired with the hub.
