# GitHub Marketplace listing

Copy for the GitHub Marketplace listing of the `hookci` GitHub App
(`hub/manifests/github-app.json`). Paste each section into the matching field
of the listing form. `scripts/check-marketplace.mjs` checks the short
description length and the permissions table against the manifest, so edit
this file and the manifest together.

Pending decisions:

- Q4 (when to list): this kit assumes the listing is submitted after M1 ships.
- Q6 (publisher): the listing is published by the GitHub organization
  `{{PUBLISHER_ORG}}`, which must pass publisher verification first.
- Q10 (domain): URLs below use the manifest host `https://ci.webuno.io`. If the
  domain changes, change the manifest and these URLs in the same commit.

## Listing name

hookci

## Short description

Run CI on your own machine, with results in GitHub Checks and Slack

(67 characters. GitHub recommends 40 to 80, sentence case, no final period,
and no app name.)

## Introductory description

hookci runs your pull request and push builds on a machine you own, then
reports every job to GitHub Checks and Slack. Install the app, pair an agent on
your box and push. No runner minutes to buy.

## Detailed description

### Builds run on your hardware

A small agent runs on your laptop, server or VM. It checks out the commit with
a short lived read only token, runs each job in an isolated sandbox and keeps
runs and logs locally. The agent dials out to the hub, so your machine needs
no inbound ports.

### No runner minutes

The agent uses your own CPU, so there is nothing to meter. The hosted hub is
free, with daily caps that keep it fair for everyone.

### Results where you already look

Each job becomes a GitHub check run, and a single `hookci` check sums them up
for branch protection. Slack gets one message per run, updated in place, with
a thread for failures.

### Works without a config file

The agent detects Go, Node.js, Python, Rust and Docker Compose projects. Add a
`.hookci.yml` to set your own commands, deploy steps or fork policy.

### Safe with forks

Pull requests from forks wait for a maintainer to press "Approve run" on the
check before any code runs on your machine.

## Pricing

Plan: Free (the only plan).

Limits of the hosted hub (the run cap resets at 00:00 UTC):

| Cap | Limit |
| --- | --- |
| Runs per day, per installation | 500 |
| Agents per installation | 10 |
| Uploaded log per job (compressed) | 10 MiB |
| Log retention on the hub | 14 days |
| Slack commands per minute, per workspace | 60 |

## Categories

- Primary: Continuous integration
- Secondary: Deployment

## Supported languages

Go, JavaScript, TypeScript, Python, Rust. Any other language runs through the
commands in `.hookci.yml`.

## Links

| Field | URL |
| --- | --- |
| Customer support (required) | https://ci.webuno.io/support |
| Privacy policy (required) | https://ci.webuno.io/privacy |
| Terms of service | https://ci.webuno.io/terms |
| Documentation | https://github.com/KCuppens/hookci#readme |
| Status | {{STATUS_PAGE_URL}} |

## Permissions and events

Every permission and webhook event in `hub/manifests/github-app.json`, with the
reason the app asks for it. GitHub shows these on the install page.

| Kind | Name | Access | Why hookci needs it |
| --- | --- | --- | --- |
| Permission | `contents` | read | The hub mints a read only token for one repository so the agent can check out the commit, and reads `.hookci.yml` for the fork policy. |
| Permission | `metadata` | read | Required by GitHub for every app; lists the repositories in the installation. |
| Permission | `pull_requests` | read | Detects pull requests from forks and confirms the head commit before an approved or retried run starts. |
| Permission | `checks` | write | Creates the per job check runs, the `hookci` aggregate check and the "Approve run" button for fork pull requests. |
| Permission | `members` | read | Confirms that a user is an organization admin before admin only actions such as binding an agent to a repository. |
| Event | `pull_request` | | Starts a run when a pull request is opened or gets new commits. |
| Event | `push` | | Starts a run on pushed branches and triggers configured deploys. |
| Event | `check_suite` | | Delivered when GitHub requests or re-requests a check suite; the hub records it, and runs start from `pull_request` and `push`. |
| Event | `check_run` | | Receives the "Approve run" button press that lets a gated fork run start. |

GitHub also sends every app the `installation` and `installation_repositories`
events without a subscription. The hub uses `installation_repositories` to keep
its repository list in sync when repositories are added to or removed from the
installation.

## Logo and screenshots

A person produces these images before submission (see
`docs/marketplace/checklist.md`).

Logo:

- Square PNG, 512x512 (GitHub needs at least 200x200; the same file serves as
  the Slack icon).
- Transparent background, no text in the image.
- Badge background color: a hex value chosen with the logo, entered in the
  listing form.

Feature card: a 965x482 background image for the Marketplace front page.

Screenshots (GitHub allows up to 5):

- PNG, at least 1200 px wide, all with the same aspect ratio. Use 1600x1000 so
  the same files fit the Slack App Directory.
- Crop to the content: no browser chrome, no personal data, a demo repository.

Capture these:

1. A pull request Checks tab showing the per job check runs and the `hookci`
   aggregate check.
2. The Slack run message with its thread for a failed job.
3. The log viewer on a finished job.
4. A terminal running `hookci doctor` with every check passing.
