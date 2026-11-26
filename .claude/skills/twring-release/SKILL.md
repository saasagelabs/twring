---
name: twring-release
description: Steps and traps for shipping any Twring piece. Use when deploying the gateway, publishing the connector bundle, making Android or iOS app builds (TestFlight, Wave 1), releasing the self-host image or the Hermes plugin, cutting GitHub releases, answering whether a change has reached users, or before reloading Caddy or restarting a server.
---

# Releasing Twring

A change is done only when users can get it. Staging comes before production, and production steps need the owner's OK.

| What changed | Release step |
| --- | --- |
| Gateway | Deploy to the server. |
| Connector | `pnpm --filter @twring/connector bundle`, publish the bundle to `/downloads` on the server, then run the site deploy script with `DEPLOY_SITE_CONNECTOR` so the self-host versions file records the bundle's digest. Commit that file. |
| App | New Android and iOS builds. |
| Plugins and integrations (Hermes) | They ship separately from the app. When a shared behaviour changes, check them too, and bump their version only if their own code changed. |

Find scripts and files by what they contain, not by a remembered path:

- the site deploy script: `git grep -l DEPLOY_SITE_CONNECTOR -- scripts`
- the self-host versions file: `git grep -l '"connect": "sha256:' -- '*.json'` (the JSON file the site serves; a TypeScript copy of the same pattern is not the one to commit)
- the Hermes plugin's release workflow: `git ls-files .github/workflows | grep -i hermes`

## GitHub releases

Every new version gets a GitHub release.

- **Self-host image:** `selfhost-vX.Y.Z` at the commit it was built from, marked Latest, once its digest is live in the versions file.
- **Hermes plugin:** `hermes-vX.Y.Z` (not Latest), plus a pull request on NousResearch/hermes-agent from the `saasagelabs/hermes-agent` fork that updates `plugin-catalog/twring.yaml`, pinned at a main commit. `hermes plugins install twring` installs only what that catalog lists.

## iOS

- **Runners:** GitHub's Apple-silicon macOS runners sometimes run out. A job "not acquired by Runner" is cancelled after about 15 minutes. Re-run it, and if that keeps happening, run the job on `macos-15-intel`. Apple requires the iOS 27 SDK (Xcode 27) for uploads from April 2027.
- **An upload reaches no tester by itself.** The run waits for the owner to approve the `testflight` environment (agents cannot approve it). After Apple processes the build, add it to the external group (Wave 1) and set its notes with the App Store Connect API. Internal groups get every build automatically and refuse a manual add, and the notes field is `whatsNew`.

## Server

- **Reloading Caddy drops every connected computer at once.** It closes all proxied WebSockets. On 2026-11-18 a site change dropped 38 computers, all back within 5 seconds, and the "computers dropping" alert fired. Reload Caddy only at 0 live calls (a reload also cuts a call), and expect that alert.
- **Restarting the gateway (or the server it runs on) also cuts every live call and drops every connected computer.** Check for 0 live calls first, and expect the same alert while computers reconnect.
