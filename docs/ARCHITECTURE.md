# Twring System Architecture

## 1. Purpose

This document defines the system boundaries all Twring implementations must preserve.

Twring is a realtime voice/call layer around an existing agent. The connected agent remains the source of intelligence, memory, tool use, permissions, and action execution.

The architecture is modular so STT/TTS can be replaced, LiveKit can move between cloud/self-hosted later, adapters can support different agent systems, and Android-first work does not force an iOS rewrite.

## 2. High-level system

```text
┌─────────────────────────────────────────────────────────────┐
│                       Twring MOBILE                           │
│ Expo + React Native                                       │
│ mic • speaker • call UI • auth • saved agents             │
└─────────────────────────────┬───────────────────────────────┘
                              │ WebRTC media + realtime data
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     LIVEKIT SESSION                         │
│ room • tracks • network adaptation • reconnect             │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Twring VOICE GATEWAY                       │
│ media ingress • STT • call controller • agent adapter      │
│ TTS • media egress • telemetry                             │
└───────────────┬─────────────────────────────────────────────┘
                │ normalized user turn / normalized agent events
                ▼
┌─────────────────────────────────────────────────────────────┐
│                  CONNECTED USER AGENT                       │
│ model • memory • tools • MCP • APIs • permissions          │
│ policy • action execution                                   │
└─────────────────────────────────────────────────────────────┘
```

## 3. Architectural invariants

- **TWR-001:** Twring does not become the connected agent's brain.
- **TWR-002:** STT/TTS/media providers have no tool authority.
- **TWR-003:** The connected agent owns its actions and tool policy.
- **TWR-004:** Critical conversational paths stream end-to-end.
- **TWR-005:** Android-first implementation remains iOS-compatible unless divergence is isolated and documented.
- **TWR-006:** Do not add infrastructure for hypothetical scale.
- **TWR-007:** Perceived realtime responsiveness is a product feature.
- **TWR-008:** Provider details stay at edges; product UI consumes Twring contracts.
- **TWR-009:** Audio cancellation and agent/action cancellation are separate concepts.
- **TWR-010:** Reconnect must not duplicate a committed user turn.

## 4. Runtime components

### 4.1 Mobile application

Responsibilities:

- authentication session;
- agent list/setup;
- microphone permission;
- audio route controls;
- connect/disconnect LiveKit;
- render call state;
- receive safe status events;
- optional transcript;
- call history;
- settings/privacy.

Mobile must never contain server-side Deepgram/LiveKit secrets or execute the connected agent's tools.

### 4.2 API/backend

Responsibilities:

- authenticate Twring users;
- CRUD agent metadata;
- encrypt credential material;
- create call sessions;
- mint short-lived LiveKit tokens;
- authorize gateway access;
- persist call metadata;
- expose history/settings;
- enforce rate limits;
- issue correlation IDs.

### 4.3 Voice gateway

Latency-critical responsibilities:

- join LiveKit room;
- subscribe to microphone audio;
- feed audio to STT;
- produce transcript/turn events;
- commit user turns;
- send committed messages to adapter;
- consume streamed agent events;
- batch safe text chunks for TTS;
- publish TTS audio;
- handle barge-in/cancellation;
- expose truthful activity;
- reconnect providers safely;
- clean up all resources.

A call is owned by one active gateway runtime at a time.

### 4.4 Connected agent

Twring assumes only that a supported adapter can send it text and obtain a result. Streaming/activity/cancellation are optional capabilities.

Twring does not assume model, framework, programming language, memory implementation, MCP usage, or tool stack.

## 5. Target workspace

```text
apps/
  mobile/
  gateway/
packages/
  contracts/
  agent-adapter/
  config/
  test-fixtures/
docs/
```

### `packages/contracts`

Schemas, discriminated event unions, stable error codes, DTOs. No provider SDK imports.

### `packages/agent-adapter`

Adapter interface plus Native WebSocket, REST/SSE, optional AG-UI compatibility, and fake adapter.

### `packages/config`

Typed environment/configuration.

### `packages/test-fixtures`

Deterministic fake agent/provider streams.

## 6. Control plane vs media plane

### Media plane

LiveKit/WebRTC carries audio and lightweight realtime presentation data tightly coupled to the call.

### Control plane

Twring API + adapter carries durable setup, call creation, credentials, normalized agent events, history, and settings.

Do not force durable business state into ephemeral media packets.

## 7. Call creation

```text
Mobile                API                Gateway          LiveKit
  │                    │                    │                │
  │ POST /calls        │                    │                │
  ├───────────────────►│                    │                │
  │                    │ create session     │                │
  │                    │ mint token         │                │
  │◄───────────────────┤                    │                │
  │ connect room       │                    │                │
  ├─────────────────────────────────────────────────────────►│
  │                    │ dispatch/prepare   │                │
  │                    ├───────────────────►│                │
  │                    │                    │ join room      │
  │                    │                    ├───────────────►│
  │◄──────────── connected/status ───────────────────────────│
```

Tell the user “Connected” only after media and gateway/adapter are ready enough to accept a turn.

## 8. Conversation path

```text
user audio
   ↓
LiveKit
   ↓
gateway audio
   ↓
streaming STT
   ↓
conversation controller
   ↓
FINAL USER TURN
   ↓
agent adapter
   ↓
connected agent
   ↓
text/activity/tool events
   ├── UI status
   └── TTS chunker → TTS → LiveKit audio → user
```

## 9. TTS chunking

Do not send individual LLM tokens to TTS.

Balance first-audio latency and prosody:

- flush first short natural phrase quickly;
- later prefer punctuation/phrase boundaries;
- enforce max buffer age/size;
- keep visible transcript separate from speech-normalized text;
- never alter agent meaning merely to make it speakable.

## 10. Cancellation model

Twring distinguishes:

- `speech_cancel`: stop current TTS;
- `turn_cancel`: ask adapter to stop current agent generation if supported;
- `call_end`: terminate call;
- `action_cancel`: belongs to connected-agent semantics.

Barge-in always implies `speech_cancel`; it does not automatically imply action rollback.

## 11. Reconnect

Use stable IDs:

- `call_id`;
- `session_id`;
- `turn_id`;
- `event_id`;
- optional monotonic `seq`.

During short loss:

1. media attempts recovery;
2. UI enters reconnecting;
3. gateway does not submit duplicate turn;
4. TTS generation identity is reconciled;
5. adapter stream resumes when supported;
6. unsafe ambiguity results in a clear recovery state, not guessing.

## 12. Idempotency

Any retryable Twring-owned mutation uses an idempotency key.

A mobile reconnect never means “send the previous user turn again.”

Native adapter should treat `turn_id` as idempotency identity.

## 13. Provider interfaces

Conceptually:

```ts
interface SpeechToTextProvider {
  open(ctx: CallContext): Promise<SttSession>;
}

interface TextToSpeechProvider {
  open(ctx: CallContext): Promise<TtsSession>;
}

interface AgentAdapter {
  connect(ctx: AgentConnectionContext, signal: AbortSignal): Promise<void>;
  sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent>;
  cancelTurn?(turnId: string): Promise<void>;
  close(): Promise<void>;
}
```

Provider SDK objects do not escape infrastructure modules.

## 14. Failure containment

STT failure:

- bounded reconnect;
- safe user status;
- no silent provider/model substitution.

TTS failure:

- preserve text;
- do not rerun agent turn merely to regenerate audio.

Adapter failure:

- stop claiming progress;
- avoid duplicate actions;
- expose safe retry.

LiveKit failure:

- recover current call if possible;
- otherwise end cleanly.

## 15. Future compatibility

Architecture should permit later:

- additional STT/TTS;
- incoming internet calls;
- AG-UI/A2A;
- self-hosted LiveKit;
- iOS CallKit-style presentation;
- Android native call integration.

None justify V1 overengineering.

## 16. Architecture change policy

A change to an invariant requires an entry in `DECISIONS.md` explaining requirement, alternatives, consequences, migration, and rollback.
