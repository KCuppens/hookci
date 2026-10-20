// Pair token issuance has no public HTTP route: there is no
// `POST /v1/pair/tokens`. Tokens are minted only by calling createPairToken
// (hub/src/pairing/tokens.ts) from flows that first check, with
// isInstallationAdmin, that the GitHub user administers the installation's
// account: the install success page (GitHub OAuth callback or the /start
// picker, both through finishInstall) and the Slack App Home "Add agent" button. A public
// route would let anyone who can reach the hub mint tokens for any
// installation id.

export {};
