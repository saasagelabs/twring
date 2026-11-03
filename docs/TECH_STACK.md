# Twring Technical Stack

## 1. Stack goals

Prioritize reliability, Android launch speed, iOS compatibility, one primary language, simple operations, provider replaceability, and strong coding-agent ergonomics.

## 2. Approved V1 stack

### Mobile

- React Native
- Expo
- Expo development builds (`expo-dev-client`)
- Expo Router
- TypeScript
- LiveKit React Native/Expo integration
- Zustand only for app/session state that outgrows React local state
- TanStack Query if server-state complexity justifies it
- React Hook Form + Zod for setup forms
- Sentry

Twring does **not** use Expo Go for the production development path because LiveKit/WebRTC requires native modules.

### Backend/gateway

- Node.js + TypeScript
- Fastify preferred unless implementation evidence favors an equally simple compatible alternative

Why TypeScript first:

- shared contracts with mobile;
- strong async streaming support;
- fewer languages for the project owner/team;
- coding-agent friendly.

### Realtime media

**LiveKit Cloud first.**

It handles WebRTC, rooms, media tracks, NAT traversal/TURN, reconnect mechanics, and cross-platform SDK plumbing.

Self-host only after a concrete cost/compliance/reliability requirement.

### STT

**Deepgram Flux first**, behind a provider interface.

### TTS

**Deepgram Aura/streaming TTS first**, behind a provider interface.

Cartesia Sonic (WebSocket, `sonic-3.6`) is an optional second TTS provider under evaluation, enabled by `CARTESIA_API_KEY`; Deepgram stays the default (ADR-020).

### Agent transport

Launch priority:

1. Twring Native WebSocket
2. REST + SSE
3. AG-UI compatibility if it does not delay core launch

Future: A2A.

MCP is normally behind the connected agent, not the Twring-to-agent transport.

### Persistence/auth

**Supabase Postgres**, likely Supabase Auth for fastest reliable V1 path.

Keep domain contracts provider-neutral.

### Package manager

`pnpm` workspaces.

Do not add Nx/Turborepo until measured build/task orchestration pain justifies it.

### CI/CD

Codemagic (`codemagic.yaml`) + Expo EAS Build/Submit. See ADR-011 in `DECISIONS.md`.

Minimum CI:

- frozen lockfile install;
- format check;
- lint;
- typecheck;
- unit tests;
- provider-fake integration tests;
- Expo/config doctor checks.

## 3. Dependency version policy

Do not guess versions in documentation.

Rules:

- initialize Expo on current stable supported SDK at implementation time;
- install Expo-native dependencies with `expo install`;
- pin exact resolved packages in `pnpm-lock.yaml`;
- commit lockfile;
- do not auto-merge major native upgrades.

Before major Expo/React Native/LiveKit/Deepgram SDK upgrades:

1. read official migration notes;
2. create dedicated upgrade task;
3. build Android and iOS;
4. run voice smoke tests;
5. merge separately from product feature work.

## 4. Likely mobile packages

Use current supported equivalents for:

- `expo-dev-client`
- `expo-router`
- `expo-secure-store`
- `expo-haptics`
- `expo-device`
- `expo-constants`
- `expo-notifications` when incoming-call work begins
- LiveKit React Native SDK and required Expo/WebRTC plugins

Do not install a UI mega-framework for V1 unless the design system genuinely needs it.

## 5. State strategy

- component ephemeral state → React state;
- app/session state → Zustand;
- server cache → TanStack Query if needed;
- call state → explicit reducer/state machine in voice domain;
- never store live provider SDK objects in serializable global state.

## 6. Validation

Use Zod at network/persistence/environment boundaries.

Prefer discriminated unions for call/adapter events and exhaustive switches.

## 7. Logging

Structured JSON backend logs with safe fields such as:

- request_id
- user_id
- call_id
- session_id
- agent_id
- turn_id
- provider
- event
- duration_ms
- error_code

Never log raw authorization headers, API keys, or full sensitive transcripts by default.

## 8. Testing

Use current stable TypeScript tooling; Vitest is preferred for unit/integration tests.

Use React Native Testing Library where it provides value.

Real-device tests are mandatory for audio behavior.

## 9. Official baseline references

- Expo dev builds: https://docs.expo.dev/develop/development-builds/introduction/
- Expo native customization: https://docs.expo.dev/workflow/customizing/
- EAS Build: https://docs.expo.dev/build/introduction/
- LiveKit Expo: https://docs.livekit.io/transport/sdk-platforms/expo/
- LiveKit pipeline types: https://docs.livekit.io/agents/models/pipelines/
- LiveKit Deepgram STT: https://docs.livekit.io/agents/models/stt/deepgram/
- LiveKit Deepgram TTS: https://docs.livekit.io/agents/models/tts/deepgram/
- Deepgram streaming TTS: https://developers.deepgram.com/docs/tts-websocket-streaming

## 10. Rejected V1 choices

### Native Android + separate Swift iOS

Rejected because it doubles product implementation without a demonstrated V1 benefit.

### Flutter

Capable, but React Native + Expo provides a direct path into the TypeScript agent ecosystem and LiveKit Expo integration.

### Web-only PWA

Not selected for launch because production mobile audio routing, background behavior, Bluetooth, notifications, and app-store experience matter.

### Raw WebRTC

Not selected because Twring differentiation is not TURN/signaling/media infrastructure.

### Realtime S2S model as agent

Explicitly rejected because it moves intelligence/action authority away from the user's connected agent.

## 11. Rule for adding technology

A new dependency/infrastructure component must answer:

- Which current V1 requirement does it satisfy?
- Why can the approved stack not solve it simply?
- What operational burden does it add?
- How is it removed if it fails?

If the answer is “we may need it someday,” do not add it.
