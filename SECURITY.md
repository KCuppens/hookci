# Security Policy

## Supported versions

zerocideploy is pre-1.0. Only the latest minor release receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report it privately in one of these ways:

- GitHub Security Advisories: use "Report a vulnerability" on the [Security tab](https://github.com/KCuppens/zerocideploy/security/advisories/new) of the repository.
- Email `security@webuno.io`.

Include a description, the affected component (agent, hub, schema), steps or a proof of concept to reproduce, and the impact you see.

## Response targets

- We acknowledge your report within 3 business days.
- We share a fix or mitigation plan within 30 days.

## Scope

- Agent sandbox escape: a job reaching the host, other jobs or other repositories beyond what its isolation allows.
- Cross-tenant hub access: one installation reading or affecting another installation's data or agents.
- Token leakage in logs: GitHub, Slack or agent tokens or secrets appearing unredacted in logs or reports.
- Webhook forgery: the hub accepting GitHub webhooks without a valid signature.
- Slack signature bypass: the hub accepting Slack requests without a valid signature.

## Out of scope

- Misconfiguration of a self-hosted setup, such as running untrusted code with `trust: all`.
- Denial of service against the shared hub by request volume.

## Safe harbor

We will not take legal action against, or ask law enforcement to investigate, anyone who researches and reports a vulnerability in good faith under this policy. Good faith means you avoid privacy violations, data destruction and service disruption, only access the data you need to show the issue, and give us reasonable time to fix it before disclosing it publicly.
