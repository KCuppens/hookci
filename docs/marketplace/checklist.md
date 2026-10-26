# Marketplace submission checklist

Walk this list before submitting hookci to the GitHub Marketplace and the Slack
App Directory. The listing copy is in `docs/marketplace/github-listing.md` and
`docs/marketplace/slack-directory.md`.

This kit assumes the listings go out after M1 ships (pending decision Q4).

## Before submitting

- [ ] `node scripts/check-marketplace.mjs` passes, so the listing copy matches
      the production manifests.
- [ ] Legal pages are live and final, with no `DRAFT` marker and no
      `{{OPERATOR}}` placeholder: https://app.hookci.com/privacy,
      https://app.hookci.com/terms and https://app.hookci.com/support load without
      signing in.
- [ ] https://app.hookci.com/.well-known/security.txt is live, with a contact
      address and an `Expires` date in the future.
- [ ] `{{STATUS_PAGE_URL}}` is replaced with a real value in the docs and the
      listing copy.
- [ ] security@hookci.com, support@hookci.com and privacy@hookci.com receive
      mail, and someone answers within 2 business days.
- [ ] Logo: square 512x512 PNG, transparent background, no text. The same file
      is the GitHub logo and the Slack icon.
- [ ] GitHub feature card: 965x482 background image.
- [ ] Screenshots: the four listed in `docs/marketplace/github-listing.md`,
      PNG at 1600x1000, under 2 MB each, from a demo repository with no
      personal data.
- [ ] The GitHub App is public (`"public": true` in
      `hub/manifests/github-app.json`) and the production app settings match
      the manifest.
- [ ] Install tested end to end on a clean GitHub account and a clean Slack
      workspace: install the GitHub App, pair an agent, add to Slack, run
      `/hookci watch`, push a commit, see the check and the Slack message,
      then uninstall both.
- [ ] Slack review test account ready: a test workspace, a reviewer Slack
      account, a GitHub account that admins the test organization, a test
      repository with one job that fails on purpose, and a demo agent paired
      and bound to it. Fill the `{{...}}` placeholders in the reviewer
      instructions of `docs/marketplace/slack-directory.md`.
- [ ] Slack only lists apps that are out of beta and installed on at least 10
      active workspaces with at least 10 weekly active users. Check the
      install count before submitting.

## GitHub Marketplace

1. Verify the publisher: in the settings of the organization
   `{{PUBLISHER_ORG}}` that owns the app (pending decision Q6), open
   Developer settings, Publisher verification, and complete it. This needs
   two factor authentication for the organization and a verified domain.
2. Move the GitHub App to that organization if it is owned by a personal
   account.
3. Open the app settings and choose "List in Marketplace" (or go to
   https://github.com/marketplace/new and pick the app).
4. Fill the listing from `docs/marketplace/github-listing.md`: name, short
   description, introductory and detailed descriptions, primary and secondary
   categories, supported languages and the links.
5. Upload the logo, set the badge background color, and upload the feature
   card and the screenshots.
6. Add one plan: Free. Leave the installation URL empty; GitHub Apps install
   from the app page.
7. Fill the contact details for the Marketplace team and the security
   contact.
8. Submit for review and answer the onboarding emails from GitHub.

## Slack App Directory

1. Open the app at https://api.slack.com/apps, then Manage Distribution.
   Complete every item in "Share Your App with Other Workspaces" and press
   "Activate Public Distribution".
2. Leave "Direct install URL" empty. The `/slack/install` route only works
   with a GitHub installation and a signed in GitHub session, so a workspace
   starts from the GitHub App install and then adds hookci to Slack from the
   page the hub shows.
3. Open "Submit to App Directory" and fill it from
   `docs/marketplace/slack-directory.md`: short and long descriptions, the
   scope justifications, the data handling answers, pricing "Free" and the
   links.
4. Upload the icon and the screenshots (1600x1000, Slack shown in context).
5. Paste the reviewer test instructions and give the credentials of the test
   accounts.
6. Confirm the scope list in the form shows the 7 bot scopes and not
   `chat:write.public`.
7. Submit, then answer the Slack review team's questions in the submission
   thread.
