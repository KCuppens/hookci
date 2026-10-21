# Self-hosting the hub

A self-hosted hub is planned for M3. You will deploy the hub Worker to your own Cloudflare account and create your own GitHub App and Slack App through a manifest flow, so webhooks, tokens and run reports never pass through the shared hub.

Until then, and by default afterwards, agents connect to the shared hub at `ci.webuno.io`. Local mode (`hookci run`) needs no hub at all.

## Email accounts (optional)

By default the hub's dashboard signs people in with GitHub only. A hub can also offer email and password accounts, Google sign-in and emailed password reset. The feature is off until you turn it on; while it is off, every `/account/...` path answers the standard 404 and the hub behaves as before.

1. **Turn it on.** Set `ACCOUNTS_ENABLED = "true"` in `[vars]` of `hub/wrangler.toml` (the default is `"false"`), and apply D1 migration `0010_accounts.sql` with the other migrations.
2. **Mail.** Verification and reset links go out through Cloudflare Email Service. The `send_email` binding named `EMAIL` is already declared in `wrangler.toml`. Set `ACCOUNTS_MAIL_FROM` in `[vars]` to a sender address such as `HookCI <no-reply@mail.example.com>` (or a bare address). Onboard that domain in the Cloudflare dashboard under Email Service and add the DNS records it asks for: SPF and DKIM at least, DMARC recommended. Until the sender is set and the domain is verified, the hub logs a failed send (never the address) and shows the same "check your email" page, so nobody can tell whether an address has an account.
3. **Google sign-in (optional).** In Google Cloud Console create an OAuth client of type "Web application" and add this authorized redirect URI, with your own hub origin:

   ```
   <HUB_ORIGIN>/account/google/callback
   ```

   For the shared hub that is `https://ci.webuno.io/account/google/callback`. Then store the client with `wrangler secret put GOOGLE_CLIENT_ID` and `wrangler secret put GOOGLE_CLIENT_SECRET`. The Google button shows only when both secrets are set. Only Google addresses marked `email_verified` are accepted.

An account proves who a person is, not what they may see. A browser signed in with email or Google sees no runs until the person also connects GitHub (the sign-in page leads them there). What they can open is decided by what GitHub says that user can access, never by their email address.
