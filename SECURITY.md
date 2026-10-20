# Security Policy

## Supported versions

zerocideploy is pre-1.0. Only the latest minor release receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report it privately in one of these ways:

- GitHub Security Advisories: use "Report a vulnerability" on the [Security tab](https://github.com/KCuppens/zerocideploy/security/advisories/new) of the repository.
- Email `{{SECURITY_EMAIL}}`.

Include a description, the affected component (agent, hub, installer, schema), steps or a proof of concept to reproduce, and the impact you see.

## Response targets

- We acknowledge your report within 3 business days.
- We share a fix or mitigation plan within 30 days.

## Disclosure

We follow coordinated disclosure with a 90-day window. We publish an advisory once a fix is released, or 90 days after your report, whichever comes first. We credit you in the advisory unless you ask us not to. If a vulnerability is actively exploited, we may disclose sooner.

## Scope

The hosted hub at `ci.webuno.io` and its GitHub and Slack Apps, the `zeroci` agent, and the installer served at `/install`. In particular:

- Agent sandbox escape: a job reaching the host, other jobs or other repositories beyond what its isolation allows.
- Cross-tenant hub access: one installation reading or affecting another installation's data or agents.
- Token leakage in logs: GitHub, Slack or agent tokens or secrets appearing unredacted in logs or reports.
- Webhook forgery: the hub accepting GitHub webhooks without a valid signature.
- Slack signature bypass: the hub accepting Slack requests without a valid signature.
- Installer tampering: the installer running a binary whose signature or checksum it did not verify.

## Out of scope

- Misconfiguration of a self-hosted setup, such as running untrusted code with `trust: all`.
- Denial of service against the shared hub by request volume.
- Vulnerabilities in GitHub, Slack or Cloudflare themselves; report those to the vendor.
- Findings from automated scanners without a demonstrated impact, and missing hardening headers on pages that hold no secrets.
- Social engineering of maintainers and physical attacks.

## Safe harbor

We will not take legal action against, or ask law enforcement to investigate, anyone who researches and reports a vulnerability in good faith under this policy. Good faith means you avoid privacy violations, data destruction and service disruption, only access the data you need to show the issue, and give us reasonable time to fix it before disclosing it publicly.
