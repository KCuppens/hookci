# The dashboard

The hub serves a small web dashboard at `/app`. It shows the runs, logs and agents of the HookCI GitHub App installations a person can access. Installation admins can also pair agents from it (see "Pairing an agent").

## What it shows

- **Installations.** A switcher lists every installation your sign-in covers. Each one has its own page at `/app/<installation id>`.
- **Runs.** The newest runs of the installation with repository, branch, commit, event, state, duration and start time. Use "Older runs" to page back. A pull request run links to its pull request.
  - **Run numbers and creation time.** Every run has a number within its installation: the first run the hub recorded for it is #1 and each new run takes the next number, so a retry is a new run with its own number. The number and the time the hub created the run do not change when the run is accepted by an agent, starts or finishes. Retention deletes the oldest runs first, so the numbers that remain keep counting up and a deleted number is not reused; only if retention has deleted every run of an installation does the next run start again at #1. Runs stored before numbering existed (migration `0018_run_number.sql`) were numbered from #1 in the order of their trigger ids, which sort by creation time, and dated from the time in that id.
- **A run.** The state and the reason, the repository, the commit, and every job with its state and duration. Each finished job links to its log.
  - **Run page header and annotations.** The run page is titled "Run #N" with N the run's number, and its summary says "Created X ago" from the time the hub created the run. The right column's configuration card also lists the run's annotations (the file notes the agent parsed from job output, newest severity first: failures, warnings, notices). Each one shows its level, optional title, message, `path:line` (linked to the file at the run's commit on GitHub when the repository is known) and job. A run with none shows "No annotations yet". A "Filter" menu hides levels in the browser without a reload. All annotation text comes from the agent and is escaped; another installation's annotations never appear.
- **Logs.** The log of a job appears after that job has ended. While a job is still running the page shows no log yet, and a reload after it ends shows the whole log.
  - **Timestamps.** The agent puts the UTC time it received each line in front of the line in the stored log: `2026-05-05T14:32:01.123Z npm ci` (a fixed 24-character ISO 8601 time with milliseconds, a `Z` and one space). The log page shows that time as `HH:MM:SS` in a column between the line number and the text (hover for the full time) and a "Timestamps" button hides or shows the column. Search looks at the text only. A log from an agent that does not stamp lines has no prefix and shows no column. The raw and download routes and `hookci logs` return the stored lines with the prefix; the failure tail shown in Slack and in check output has it removed.
- **Agents.** The agents paired to the installation, whether each one is connected right now, when it was last seen, its version, its platform (the OS release the agent reports, such as "Ubuntu 22.04", falling back to the raw OS name, plus the architecture), its protocol version, how many repositories it serves, and an "Upgrade available" note when the agent is older than the newest version the hub knows. Every row, revoked agents included, has a three-dot menu, and an installation with no agents shows the install command with a copy button and a link to the setup guide.
- **Repositories.** The repositories the installation can see, one row each: name (with the short name beneath), default branch, the agent that serves it (or "No agent bound", "Offline", "Revoked"), its deploy environments (staging before production), its Slack channels (a broken watch shows "Channel not found"), the last run with how long ago it started (for example "12 minutes ago"), and an "Open on GitHub" button plus a three-dot menu. A search box and a Filter menu narrow the list on the server. "Bind repositories" opens `/app/<installation id>/repositories/bind`, where ticking several repositories (or arriving with `?repo=<id>`) binds them all to one agent in one submission.

## Pairing an agent

Installation admins can pair a new agent from the Agents page with "Pair agent". The button posts a form to `/app/<installation id>/agents/pair`, which needs your session, a CSRF token and a same-origin request, and creates a one-time pair token. The next page shows the install command, the `sudo hookci connect <token>` command, the time left on the token, and a live status that the page polls at `/app/<installation id>/agents/pair/status` until the agent connects. The token is shown only on that page: it is never put in a URL and never written to the logs, and "Regenerate" issues a new one. A token is valid for 15 minutes. An installation can have at most 10 agents and a hub issues at most 10 pair tokens per installation per hour; past either limit the page says so instead of issuing a token. To replace the credential of a lost agent, choose that agent in "Pairing a replacement agent": the new token keeps its name and bindings.

## One agent

Each row of the Agents page links to `/app/<installation id>/agents/<agent id>`: the agent's status, version, platform, who paired it, the repositories it serves (with when each was bound), its recent runs, and the commands to upgrade or restart it. An agent of another installation answers the same not-found page as a missing one. Installation admins can revoke the agent (`POST .../revoke`) or unbind one repository from it (`POST .../bindings/unbind`). Both need your session, a CSRF token and a same-origin request, and both are logged. Revoking also drops the agent's bindings.

## Signing in

- **GitHub.** The default. The sign-in button sends you to GitHub; GitHub tells the hub which installations of the HookCI App you can access, and the dashboard shows exactly those.
- **Email and Google.** Available only when the hub operator sets `ACCOUNTS_ENABLED = "true"` (see [self-hosting.md](self-hosting.md)). You can create an account with an email address and a password, or sign in with Google. An account proves who you are, not what you may see: it shows no runs until you also connect GitHub, and what you can open is then decided by what GitHub says you can access. Your email address is never used for access.

The sign-in, create-account, reset-password and connect-GitHub pages share one design: a centred card on the HookCI background, with the Docs, Pricing and Support links in the header. On a phone the header keeps those links in a single row next to the GitHub button. The page art (icons, the feature tiles and the background curves) is inline SVG generated from the design mockups, so these pages load no images and need no extra requests.

## Sessions

A sign-in lasts 30 minutes. The session is a signed cookie, so the hub keeps no session table. When it expires, the dashboard asks you to sign in again. Signing out removes the cookie from your browser straight away. A copy of the cookie made earlier would still be accepted by the hub until its 30 minutes end.

## Account settings, sign out and delete

When accounts are enabled, the dashboard header shows a Sign out button, and for a signed-in email or Google account a Settings link.

- **Settings** (`/account/settings`) shows your email address and the GitHub login you connected, if any. It has Connect GitHub, Sign out and Delete account.
- **Delete account** (`/account/delete`) removes your email account and its pending sign-in and reset tokens. You confirm with your password. An account without a password, such as one made with Google, confirms by typing its email address. Wrong passwords count toward the same lockout as sign-in. Your runs and logs belong to your GitHub installations, so they stay. Deleting also signs you out.
- Every form uses a signed token tied to your browser and refuses requests from other origins.
- **Linking your GitHub account to Slack.** `/hookci me` in Slack sends you to a confirmation page that names the Slack workspace and user ID being linked and what the link allows. Only the Continue to GitHub button (a POST) starts the GitHub sign-in; Cancel leaves without linking. The page has the site header but no footer.

## Public status page

`/status` needs no sign-in. It shows an overall banner, the API, agent connections and log storage components with 30 days of uptime bars, and the recent incidents. The footer credits "Powered by HookCI" with a link to the project on GitHub. On screens narrower than 900 pixels the footer credit and links stack in the centre.

## Pages that answer 404

The hub answers the same plain "Page not found" page instead of a more specific refusal in these cases, so nobody can probe which ids exist:

- A page or log under `/app/<installation id>` when your session does not cover that installation, when it does not exist, or when it was uninstalled.
- A run that does not exist in an installation you can see, or a job that has no log yet.
- Any `/account/...` path when `ACCOUNTS_ENABLED` is not `"true"`. These answer the JSON 404 `{"error":"not_found"}`.

Opening `/app` with no valid session shows the sign-in page instead. An expired session on a deeper page shows the 404 page; open `/app` to sign in again.
