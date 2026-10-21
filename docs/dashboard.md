# The dashboard

The hub serves a small read-only web dashboard at `/app`. It shows the runs, logs and agents of the HookCI GitHub App installations a person can access. It never changes anything: it cannot start, cancel or retry a run.

## What it shows

- **Installations.** A switcher lists every installation your sign-in covers. Each one has its own page at `/app/<installation id>`.
- **Runs.** The newest runs of the installation with repository, branch, commit, event, state, duration and start time. Use "Older runs" to page back. A pull request run links to its pull request.
- **A run.** The state and the reason, the repository, the commit, and every job with its state and duration. Each finished job links to its log.
- **Logs.** The log of a job appears after that job has ended. While a job is still running the page shows no log yet, and a reload after it ends shows the whole log.
- **Agents.** The agents paired to the installation, whether each one is connected right now, when it was last seen and its version.

## Signing in

- **GitHub.** The default. The sign-in button sends you to GitHub; GitHub tells the hub which installations of the HookCI App you can access, and the dashboard shows exactly those.
- **Email and Google.** Available only when the hub operator sets `ACCOUNTS_ENABLED = "true"` (see [self-hosting.md](self-hosting.md)). You can create an account with an email address and a password, or sign in with Google. An account proves who you are, not what you may see: it shows no runs until you also connect GitHub, and what you can open is then decided by what GitHub says you can access. Your email address is never used for access.

## Sessions

A sign-in lasts 30 minutes. The session is a signed cookie, so the hub keeps no session table. When it expires, the dashboard asks you to sign in again. Signing out removes the cookie from your browser straight away. A copy of the cookie made earlier would still be accepted by the hub until its 30 minutes end.

## Account settings, sign out and delete

When accounts are enabled, the dashboard header shows a Sign out button, and for a signed-in email or Google account a Settings link.

- **Settings** (`/account/settings`) shows your email address and the GitHub login you connected, if any. It has Connect GitHub, Sign out and Delete account.
- **Delete account** (`/account/delete`) removes your email account and its pending sign-in and reset tokens. You confirm with your password. An account without a password, such as one made with Google, confirms by typing its email address. Wrong passwords count toward the same lockout as sign-in. Your runs and logs belong to your GitHub installations, so they stay. Deleting also signs you out.
- Every form uses a signed token tied to your browser and refuses requests from other origins.

## Pages that answer 404

The hub answers the same plain "Page not found" page instead of a more specific refusal in these cases, so nobody can probe which ids exist:

- A page or log under `/app/<installation id>` when your session does not cover that installation, when it does not exist, or when it was uninstalled.
- A run that does not exist in an installation you can see, or a job that has no log yet.
- Any `/account/...` path when `ACCOUNTS_ENABLED` is not `"true"`. These answer the JSON 404 `{"error":"not_found"}`.

Opening `/app` with no valid session shows the sign-in page instead. An expired session on a deeper page shows the 404 page; open `/app` to sign in again.
