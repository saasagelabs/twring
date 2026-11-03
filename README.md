# Twring

**Bring any agent brain. Get the voice.**

Twring lets you call the AI agents you already run (Claude Code, Codex, Hermes and others) from your phone, and lets them call you. Your agent keeps its own model, memory and tools; Twring adds the call: speech in and out, turn-taking, interruptions, rings on a locked phone, chats and files.

## Three ways to use it

- **Twring's service:** install the app (iPhone and Android), sign in, connect your agent. Nothing to run.
- **Your own speech keys:** use Twring's service with your own Deepgram, Cartesia or xAI account.
- **Your own server:** run Twring on your own machine or VPS with one command, then pair the app by scanning a code:

      curl -fsSL https://twring.com/install.sh | sudo sh

  The guide: https://twring.com/self-hosting/guide/

## What is in this repository

| Folder | What it is |
| --- | --- |
| `apps/gateway` | The server: calls, agents, chats, rings, self-hosted mode |
| `apps/relay` | The ring relay that wakes a locked phone for self-hosted servers |
| `apps/mobile` | The phone app (Expo, React Native) |
| `apps/connector` | `twring-connect`, the tool that links an agent's computer |
| `apps/site` | twring.com |
| `deploy/selfhost` | The self-host kit: installer, `twring` command, compose files |
| `packages/` | Shared contracts, config, adapters and push |
| `skills/twring` | The agent skill: how an agent behaves on a Twring call |
| `docs/` | Product, architecture, voice, security and decisions |

## Develop

    corepack enable
    pnpm install
    pnpm typecheck && pnpm lint && pnpm test

Start with `CLAUDE.md` and `docs/ARCHITECTURE.md`. Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

Setup, keys, device testing and the names you will still see: docs/DEVELOPMENT.md.

## License

The server, relay and self-host kit are AGPL-3.0; the app, the computer tool and everything else are Apache-2.0. Details: [LICENSE.md](LICENSE.md). The Twring name and logo: [TRADEMARKS.md](TRADEMARKS.md).
