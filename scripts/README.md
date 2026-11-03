# Scripts

Run from the repo root in Git Bash or any POSIX shell. None of them print secrets. Twring's own server operations (deploys, backups, invites, reports) use private operations scripts that are not part of this repository.

## Public scripts

| Script | What it does |
| --- | --- |
| `deploy-site.sh` | Publishes twring.com from `apps/site` |
| `package-skill.sh` | Packs `skills/twring` and can publish it to twring.com/downloads |
| `publish-image.sh` | Builds and publishes the self-hosting server image |
| `selfhost-smoke.sh` | Smoke test for a self-hosted server |
| `check-no-em-dash.mjs` | Part of `pnpm lint`: fails on em dashes |
| `open-source/` | The public export tool and its checks |

Android release builds: `apps/mobile/scripts/build-android-release.sh`.
