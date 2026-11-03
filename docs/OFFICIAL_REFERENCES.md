# Twring Official References

Coding agents should re-check official documentation before upgrades or when an API has changed.

## Expo

- Development builds: https://docs.expo.dev/develop/development-builds/introduction/
- Native code/customization: https://docs.expo.dev/workflow/customizing/
- EAS Build: https://docs.expo.dev/build/introduction/

Twring requires a development build rather than Expo Go because LiveKit uses native WebRTC modules.

## LiveKit

- Expo quickstart: https://docs.livekit.io/transport/sdk-platforms/expo/
- Pipeline types: https://docs.livekit.io/agents/models/pipelines/
- STT overview: https://docs.livekit.io/agents/models/stt/
- Deepgram STT: https://docs.livekit.io/agents/models/stt/deepgram/
- Deepgram TTS: https://docs.livekit.io/agents/models/tts/deepgram/

Twring uses LiveKit primarily as media/call infrastructure. The connected external agent remains the brain.

## Deepgram

- Flux: https://developers.deepgram.com/docs/flux/quickstart
- Streaming TTS: https://developers.deepgram.com/docs/tts-websocket-streaming

## AG-UI

- Events: https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/events.mdx

## A2A

- Protocol: https://a2a-protocol.org/

A2A is future-facing for V1 unless real demand appears.

## Codex

- OpenAI Codex / AGENTS.md behavior: https://openai.com/index/introducing-codex/

## Claude Code / Anthropic

- Anthropic documentation: https://docs.anthropic.com/

`CLAUDE.md` is Twring's repo-level briefing for Claude Code. Re-check current Claude Code project instruction conventions as tooling evolves.

## Rule

Official docs beat blog posts.

If a coding agent discovers an API changed:

1. use current official docs;
2. implement the smallest compatible change;
3. update this file if the canonical reference moved;
4. create an ADR only if architecture changes.
