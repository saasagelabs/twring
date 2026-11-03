# Twring Voice Architecture

## 1. Objective

Create a call experience using:

```text
speech → STT → connected agent → TTS → speech
```

without allowing a realtime speech-to-speech model to become the agent brain.

The user should perceive one continuous conversation, not alternating voice messages.

## 2. Quality target

The system should:

- listen continuously;
- detect when the user has actually yielded the floor;
- commit the turn quickly;
- stream the connected agent;
- begin speech before the full response is generated;
- allow interruption;
- react clearly when the agent is performing slow work.

## 3. Pipeline

```text
Microphone
   ↓
LiveKit/WebRTC
   ↓
Gateway media input
   ↓
Streaming STT
   ├── partial transcript → optional UI
   └── end-of-turn/final
           ↓
Conversation controller
           ↓
Committed UserTurn
           ↓
Agent adapter
           ↓
Agent events
   ├── activity/tool → UI
   └── text.delta
           ↓
TTS text chunker
           ↓
Streaming TTS
           ↓
audio frames
           ↓
LiveKit/WebRTC
           ↓
Speaker
```

## 4. Audio ownership

Twring/LiveKit owns the call audio channel.

The connected agent receives text/events in V1. Do not forward raw microphone audio to arbitrary agent endpoints.

This provides:

- consistent STT;
- consistent interruption;
- stable privacy boundary;
- provider independence;
- one adapter contract.

## 5. STT behavior

Use Deepgram Flux initially.

Twring consumes normalized:

- partial text;
- final text;
- turn/end-of-turn signals;
- error/recoverability metadata.

Rules:

- partial transcript is not an authoritative agent instruction;
- committed agent work starts only from a finalized Twring user turn;
- partials may drive captions;
- duplicated finals are deduplicated where possible.

## 6. Turn commitment

Turn commitment combines provider signals and Twring safeguards.

Consider:

- provider end-of-turn;
- local user-speaking state;
- minimum utterance validity;
- interruption state;
- active call state;
- small false-endpoint debounce if measured necessary.

Avoid arbitrary long fixed silence timers.

## 7. Agent invocation

On commit:

```ts
const turn: UserTurn = {
  callId,
  sessionId,
  turnId,
  role: "user",
  text,
  startedAt,
  committedAt,
};
```

Send the turn exactly once.

Use an `AbortController` for agent generation cancellation where supported.

## 8. Agent text streaming

Agent text is assembled into three concepts:

- generated text;
- text queued for TTS;
- text already spoken.

UI transcript may stream at delta speed.

TTS uses semantic chunks.

## 9. TTS chunking policy

Initial strategy:

1. Buffer text deltas.
2. Flush the first short natural phrase quickly.
3. Later flush at sentence/clause boundaries.
4. Enforce max buffered characters/time.
5. Avoid sending incomplete markdown/control syntax.
6. Normalize speech text separately from visible transcript.
7. Preserve meaning.

Do not send individual tokens as individual TTS requests.

As built with Flux TTS (ADR-014): one agent turn is one streamed Flux turn. `SpeechTextFilter` sends whole words as they arrive and holds back incomplete links; Flux places its own synthesis boundaries, so Twring does no sentence chunking. Steps 1–4 apply again if a TTS vendor without streamed-text input is added.

## 10. Barge-in

While agent audio plays, microphone capture remains active.

On confident user speech:

1. transition to `INTERRUPTING`;
2. stop local/gateway TTS playout immediately;
3. cancel queued unsent speech;
4. invalidate the old `speechGenerationId`;
5. continue STT for new user turn;
6. optionally request adapter generation cancellation;
7. never assume an external tool action was reversed.

## 11. False interruption / echo

Test:

- speakerphone loud;
- earpiece;
- Bluetooth;
- wired headset;
- quiet room;
- noisy room.

Do not disable interruption globally because of echo bugs. Fix audio processing/detection.

## 12. Agent working without text

If adapter emits a real activity event, render it.

If not, show generic:

> Working…

Do not fabricate tool names or progress percentages.

## 13. Filler policy

Default: Twring does not generate conversational filler.

Avoid:

> “Please wait while I process your request.”

If the connected agent emits a natural acknowledgement, Twring may speak it because it belongs to the agent.

Twring may use non-semantic UI sound/haptic for call state.

Exception (ADR-028, owner-approved): while a committed turn has produced no agent text, Twring plays
a soft "heard you" tone after 700 ms and may speak short progress lines in the agent's voice
("Still working: running a command.", "Still working on it.") built only from the agent's own
activity/tool events. A stop request that cancels a working turn is answered by Twring with
"Okay, stopped." `PRESENCE_CUES=off` disables the tone and the progress lines.

Exception (ADR-032, owner-approved): when an owner turn still has no agent text after 1.5 s, Twring
says one short acknowledgement in the agent's voice ("Okay, one moment."), once per turn, cut by the
agent's first words. It claims nothing about the work. `PRESENCE_ACK=off` disables it.

## 14. TTS cancellation contract

TTS session exposes conceptually:

```ts
enqueue(text, generationId)
flush(generationId)
cancel(generationId)
clearPending(generationId)
close()
```

Every returned audio chunk is tagged to a Twring speech generation.

Late audio from an invalidated generation is discarded.

## 15. Audio routes

Support:

- speaker;
- earpiece where appropriate;
- Bluetooth;
- wired headset;
- route changes mid-call.

Call state survives route changes.

## 16. Network degradation

During brief media degradation:

- preserve call UI;
- show reconnecting when confirmed;
- avoid duplicate turn commits;
- avoid replaying old TTS;
- recover same logical call when possible.

If recovery budget is exhausted, end with a clear reason and redial action.

## 17. Latency measurement points

Record monotonic timestamps:

- user_speech_started
- user_speech_ended
- turn_committed
- agent_request_started
- agent_first_event
- agent_first_text
- tts_first_text_enqueued
- tts_first_audio_received
- audio_first_published
- barge_in_detected
- tts_stopped

Use monotonic time for duration calculations.

## 18. Normalized provider contracts

Example:

```ts
type SttEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "turn_end"; text: string }
  | { type: "error"; code: string; recoverable: boolean };

type TtsEvent =
  | { type: "audio"; data: Uint8Array; generationId: string }
  | { type: "flushed"; generationId: string }
  | { type: "error"; code: string; recoverable: boolean };
```

Product UI never imports provider event types.

## 19. Required voice scenarios

- short question;
- long monologue;
- hesitation/pause mid-sentence;
- immediate interruption;
- interruption after long answer;
- agent returns text instantly;
- agent spends 15+ seconds in tool work;
- Wi-Fi/mobile transition;
- headphones connect/disconnect;
- STT reconnect;
- TTS reconnect;
- late TTS packets after cancel;
- duplicate adapter events.

## 19a. xAI listening and voice (own key only)

- Listening starts a turn on the first recognised words, not on raw voice activity, so barge-in is noticed about half a second later than with Deepgram Flux (to be measured on staging).
- Voice cancel sends `text.clear` and drops audio until `audio.clear` arrives (clears are counted; 2 s drain timeout).
- Error frames without key wording reconnect; four non-key refusals within 10 s end the call (the pipeline reconnect budget).
- Voice notes on xAI use the file endpoint with phase 1's retry policy. Listen uses one-shot MP3.
- Grok voices never fail over to another provider.

## 20. Anti-patterns

Do not:

- wait for full agent answer before speaking;
- treat STT partials as action-authoritative;
- forward provider events directly to UI;
- generate fake agent filler;
- play late audio from interrupted turn;
- replay user turn on reconnect;
- couple action cancellation to audio cancellation.
