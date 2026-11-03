# Twring app

The Twring phone app for Android and iPhone: Expo (development builds, not Expo Go), React Native, TypeScript, expo-router.

## What lives where

| Folder | Job |
| --- | --- |
| `src/app` | Screens (expo-router): sign-in, agents, chats, recents, settings, the call and incoming ring |
| `src/call` | Starting and running a call over LiveKit |
| `src/ring` | Incoming rings, answering from the lock screen |
| `src/threads` | Chats, voice notes, files and Listen |
| `src/agents` | Adding, linking and testing agents |
| `src/auth`, `src/access` | Google and Apple sign-in, invite codes |
| `src/platform` | Everything that differs between Android and iPhone, behind one interface |
| `src/api` | The typed client for the gateway |
| `src/components`, `src/theme` | Shared UI and the design tokens |
| `modules/cord-call-service` | The native module: Android foreground call service and ring screen, iPhone CallKit and push |
| `plugins` | Expo config plugins (incoming calls, release signing) |

## Run it

```bash
cp .env.example .env.local   # point it at your gateway
pnpm --filter @twring/mobile android    # build, install and launch on a connected Android phone
pnpm --filter @twring/mobile start      # Metro only, once the app is installed
```

iPhone builds come from GitHub Actions (`.github/workflows/ios-testflight.yml`, workflow "iOS: TestFlight build", started by hand from `main`). Three variants exist, each with its own app ID and link scheme: development, staging and production (`app.config.ts`).

## Test

```bash
pnpm --filter @twring/mobile test
pnpm --filter @twring/mobile typecheck
pnpm run expo:doctor
```

Before any build reaches people, run [`docs/RELEASE_TEST_LIST.md`](../../docs/RELEASE_TEST_LIST.md) on a real Android phone and iPhone. Release builds and signing are in Twring's operations notes (private).

## Words on screen

The app is for people who know nothing about the plumbing. No "MCP", "connector", "twring-connect", "adapter" or "beta" in anything a person reads; `src/agents/no-jargon.test.ts` checks the common cases.
