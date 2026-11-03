# Twring gateway

The Twring server: one Node.js process (Fastify, TypeScript) that runs calls, voice, rings, chats, accounts and invites. Production is `api.twring.com`.

## What lives where

| Folder | Job |
| --- | --- |
| `src/calls`, `src/livekit` | Call setup, LiveKit rooms and tokens, live call limits |
| `src/conversation` | Turn-taking, interruptions, approvals, the lines Twring speaks itself |
| `src/voice`, `src/audio` | Deepgram speech to text, Deepgram and Cartesia text to speech |
| `src/agents` | Saved agents, voices, connection tests, relinking a computer |
| `src/connectors` | Computers linked with `twring-connect` (they dial out to here) |
| `src/ring` | Rings: Firebase push for Android, Apple push for iPhone |
| `src/threads`, `src/files` | Chats, voice notes and files |
| `src/mcp` | The connector AI apps use to ring and message (`/mcp`) |
| `src/waitlist`, `src/beta` | Access requests, invite codes and invite emails |
| `src/me`, `src/auth*` | The signed-in person: Supabase and Apple sign-in, settings, deleting data |
| `src/notify` | Alert emails to the owner (failures, disk, capacity) |
| `src/store` | File-backed storage with encrypted credentials |
| `src/pages` | The few pages the server renders itself |
| `scripts/` | Smoke tests, probes, load test, cost report and the admin tools behind `scripts/*.sh` |

## Run it

```bash
cp .env.example .env      # fill in only what you need; see the comments in the file
pnpm --filter @twring/gateway dev
```

Health: `GET /health/live` and `GET /health/ready`. Settings are validated at startup by `@twring/config`; a bad or missing value stops the server with a clear message. Staging and production need the values in `.env.staging.example` and `.env.production.example`.

## Test

```bash
pnpm --filter @twring/gateway test               # unit tests
pnpm --filter @twring/gateway test:integration   # with the fake agents
pnpm --filter @twring/gateway run build && pnpm --filter @twring/gateway run smoke
```

Live provider checks (need real keys): `livekit:smoke`, `voice:smoke`, `conversation:smoke`, `load:test`.

## Deploy

The operations scripts deploy to staging or production. They build on the server at low priority, wait for live calls to end, and keep the previous release for rollback. Everything about the servers is in Twring's operations notes (private).
