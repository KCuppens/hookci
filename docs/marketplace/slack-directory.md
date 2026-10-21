# Slack App Directory listing

Copy for the Slack App Directory submission of the `hookci` Slack app
(`hub/manifests/slack-app.yml`). `scripts/check-marketplace.mjs` checks the
bot scopes table against `oauth_config.scopes.bot` in the manifest, so edit
this file and the manifest together.

Pending decision: Q4 (when to list, assumed after M1). URLs below use the
manifest host `https://ci.hookci.com`.

## App name

hookci

## Short description

CI on your own machine, reported to Slack

## Long description

hookci runs your GitHub builds on a machine you own and reports them where
your team already talks.

*What you get*
- One message per run in the channels you choose, updated in place as jobs
  finish, with a thread reply per finished job.
- A failure alert with the end of the job's log and a link to the full log.
- One mention of the commit author on a failure, or a direct message instead.
- `/hookci` to watch repositories, check status, retry a run and bind agents.
- An App Home tab that lists your agents and lets admins pair a new one.

*How it works*
A small agent on your server, laptop or VM runs the jobs. The hosted hub
relays GitHub webhooks to it and posts the results to GitHub Checks and Slack.
There are no runner minutes to buy.

*Pricing*
Free.

## Bot scopes

Exactly the scopes in `oauth_config.scopes.bot`. No user scopes are requested.

| Scope | Feature that uses it |
| --- | --- |
| `chat:write` | Posts and updates run messages, failure threads, deploy messages and offline alerts to admins, and the test message sent by `/hookci watch`. |
| `commands` | Registers the `/hookci` slash command. |
| `channels:read` | `/hookci watch` checks that the bot is a member of a public channel, and the `notify.slack` channel name in `.hookci.yml` is resolved to a channel. |
| `groups:read` | The same checks for private channels the bot was invited to. |
| `im:write` | Opens a direct message with the commit author when a watch uses the `dm` alert mode. |
| `users:read` | Required by Slack with `users:read.email` for the author lookup below. |
| `users:read.email` | Finds the Slack user whose email matches the commit author, to mention them once on a failure. Only a SHA-256 hash of the email is cached, for 24 hours. |

`chat:write.public` is NOT requested. The bot only posts in channels it has
been invited to, and `/hookci watch` tells the user to invite it first.

## Slash commands

All commands are subcommands of `/hookci`. Write and admin actions check the
user's role on the linked GitHub repository or organization.

| Command | What it does |
| --- | --- |
| `/hookci watch <owner/repo> [quiet] [dm]` | Posts the repository's run messages in this channel. `quiet` lists job results in the run message instead of replying in its thread; `dm` sends failure alerts to the commit author by direct message. |
| `/hookci unwatch <owner/repo>` | Stops posting the repository's runs in this channel. |
| `/hookci status [owner/repo]` | Shows the agents and the repository's last 5 runs. |
| `/hookci retry <owner/repo> [sha]` | Runs the latest run of the repository, or of the given commit, again. |
| `/hookci bind <owner/repo> <agent> [checks\|deploy:<env>]` | Makes an agent run the repository's checks or a deploy environment (admins only). |
| `/hookci sink add\|list <owner/repo>` | Opens a form that sends the repository's run updates to a Telegram chat or a signed webhook, or lists those sinks (admin or maintain on the repository). Bot tokens and URLs go in the form, never in the command. |
| `/hookci sink remove\|test <sink-id>` | Removes a sink, or sends it a test delivery (admin or maintain on the repository). |
| `/hookci me` | Links your GitHub account through GitHub sign in; `/hookci me unlink` removes the link. |
| `/hookci export` | Sends you a link to a JSON copy of your data. |
| `/hookci delete-my-data` | Deletes your GitHub link and author mappings in this workspace. |
| `/hookci help` | Lists the commands. A bare `/hookci` does the same. |

## Data handling

Answers for the security and compliance section of the submission. The full
text is the privacy policy at https://ci.hookci.com/privacy.

- What is stored: workspace and channel IDs, the encrypted bot token, watch
  settings, the GitHub login linked with `/hookci me`, run results and job
  logs. Message contents and files in Slack are never read or stored. Source
  code and secrets are never stored; secrets are masked in logs.
- Retention: job logs are kept 14 days on the hub. A SHA-256 hash of an author
  email is cached for 24 hours. All data for a workspace is deleted within 30
  days of uninstalling the app.
- Deletion: uninstalling the app starts the deletion. A user can remove their
  own data at any time with `/hookci delete-my-data`, or ask
  privacy@hookci.com.
- Where data is stored: Cloudflare D1 and R2, in the EU jurisdiction where
  Cloudflare offers it. Subprocessors are Cloudflare (hosting) and bugwatch
  (error reports).
- Encryption: all traffic uses TLS. Slack bot tokens are encrypted at rest with
  AES-256-GCM under a rotating key, bound to the workspace ID. Cloudflare
  encrypts D1 and R2 at rest.

## Test instructions for Slack reviewers

Paste this into the reviewer instructions field. Fill in the placeholders when
the test workspace is set up (see `docs/marketplace/checklist.md`).

1. Join the test workspace `{{TEST_WORKSPACE_URL}}` with the reviewer account
   `{{REVIEW_ACCOUNT_EMAIL}}`. hookci is already installed there.
2. Run `/hookci me` and sign in to GitHub as `{{REVIEW_GITHUB_LOGIN}}` (password
   in the credentials field). This test account is an admin of the
   organization that owns the test repository `{{TEST_REPO}}`, so every
   command works for it.
3. The demo agent `{{DEMO_AGENT_NAME}}` is paired and bound to `{{TEST_REPO}}`.
   The App Home tab shows it online.
4. In `#hookci-review`, run `/hookci status {{TEST_REPO}}`. The agent and the
   last runs appear.
5. Run `/hookci watch {{TEST_REPO}}`. A test message appears in the channel.
6. Run `/hookci retry {{TEST_REPO}}`. A run message appears and updates as the
   jobs finish, with a thread reply per job. One job fails on purpose, so a
   failure alert appears with the end of its log and a link to the full log.
7. To pair an agent yourself: open the App Home tab, press "Add agent" and run
   the two commands the modal shows on a Linux server or VM. The agent shows
   up online in App Home. Bind it with
   `/hookci bind {{TEST_REPO}} <agent>`.
8. Run `/hookci delete-my-data`. The reply lists what was deleted.

## Links

The hub has no page at its root, so the repository README serves as the
landing page.

| Field | URL |
| --- | --- |
| Landing page | https://github.com/KCuppens/hookci#readme |
| Support | https://ci.hookci.com/support (email support@hookci.com, no account needed) |
| Privacy policy | https://ci.hookci.com/privacy |
| Terms of service | https://ci.hookci.com/terms |
