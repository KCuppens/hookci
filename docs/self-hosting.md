# Self-hosting the hub

A self-hosted hub is planned for M3. You will deploy the hub Worker to your own Cloudflare account and create your own GitHub App and Slack App through a manifest flow, so webhooks, tokens and run reports never pass through the shared hub.

Until then, and by default afterwards, agents connect to the shared hub at `ci.webuno.io`. Local mode (`hookci run`) needs no hub at all.
