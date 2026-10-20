DRAFT: requires human legal review before publication

# ZeroCI privacy policy

This policy covers the shared ZeroCI hub, its GitHub App and its Slack App.

## Who operates the shared hub

The shared hub is operated by {{OPERATOR}}. Questions about this policy go to privacy@webuno.io.

## What data we store

- GitHub installation ids and the names of the accounts they belong to.
- Repository names, branch names, commit SHAs and titles, and pull request numbers.
- Run metadata: which jobs ran, on which agent, their status, timing and result.
- Slack workspace, channel and user ids.
- GitHub logins linked to Slack users, and the GitHub logins of commit authors.
- A one way hash of a commit author's email, kept for 24 hours, used only to find the matching Slack user. The email itself is not stored.
- Job logs that your agent uploads to the hub.

## What we never store

- Your source code. Jobs run on your own machines, and the agent never sends the repository to the hub.
- Secrets and environment files. The agent does not send them to the hub, and it masks the secret values it knows in job logs before it uploads them.

## Retention

| Data | Kept for |
| --- | --- |
| Job logs | 14 days, then deleted automatically |
| Run metadata | While the installation exists, and at most 14 days per run |
| Installation, repository and Slack workspace records, linked GitHub logins | While the installation exists |
| All of the above after you uninstall the GitHub App or the Slack App | Deleted within 30 days of uninstall |

## Where data is stored

Data is stored on Cloudflare, in D1 databases and R2 storage. Where Cloudflare offers it, we use the EU jurisdiction so stored data stays in the European Union. Cloudflare may handle requests at edge locations outside the European Union.

## Subprocessors

| Subprocessor | Purpose | Data |
| --- | --- | --- |
| Cloudflare | Hosting, D1 database, R2 log storage | All data listed above |
| bugwatch | Error reporting | Error reports, scrubbed of tokens, secrets and personal data |
| Transactional email provider | Sending email, if the hub ever sends any; none is used today | Email address and message, only when used |

GitHub and Slack receive the data you share with them through their apps. Their own privacy policies apply to that data.

## Cookies

The hub sets only strictly necessary cookies that keep a sign in or install flow secure. It sets no tracking or analytics cookies.

## Your rights

- Export: run `/zeroci export` in Slack to download what ZeroCI stores about you.
- Deletion: run `/zeroci delete-my-data` in Slack to delete your Slack to GitHub link and author mappings at once. Uninstall the GitHub App or the Slack App to delete the installation data within 30 days.
- Access, correction and objection: email privacy@webuno.io. You may also complain to your data protection authority.

## Self hosted hubs

This policy does not cover hubs that other people run themselves. Whoever runs a self hosted hub is responsible for the data it stores.

## Changes

We announce changes to this policy in the repository before they take effect.
