# Twring Call State Machine

## 1. Why this exists

Natural call behavior cannot be safely implemented using scattered booleans such as `isListening`, `isSpeaking`, and `isLoading` because they can contradict each other.

Twring uses an explicit deterministic state machine/reducer.

## 2. Primary states

```text
IDLE
PREPARING
CONNECTING
LISTENING
USER_SPEAKING
TURN_COMMITTING
AGENT_WORKING
AGENT_SPEAKING
INTERRUPTING
RECONNECTING
ENDING
ENDED
FAILED
```

## 3. State meanings

### IDLE

No active call resources.

### PREPARING

API is creating a logical call/session and obtaining short-lived credentials.

### CONNECTING

Mobile is joining LiveKit and gateway/provider/adapter readiness is being established.

### LISTENING

Call is connected and user has the floor.

### USER_SPEAKING

Confident user speech is being captured.

### TURN_COMMITTING

STT/turn controller is finalizing the user turn. Normally very brief.

### AGENT_WORKING

Committed turn has been sent to the connected agent. No audible agent speech currently plays.

### AGENT_SPEAKING

TTS audio for current agent turn is playing/published.

### INTERRUPTING

User started speaking while agent was speaking. Twring is stopping TTS and transferring the floor.

### RECONNECTING

Active logical call temporarily lost required transport/provider connectivity.

### ENDING

Resources are closing. New speech is ignored.

### ENDED

Clean completion.

### FAILED

Call cannot continue. Error contains stable code, safe message, retryability, correlation ID.

## 4. Representative events

```ts
type CallEvent =
  | { type: "START_REQUESTED"; agentId: string }
  | { type: "SESSION_CREATED"; callId: string }
  | { type: "MEDIA_CONNECTED" }
  | { type: "GATEWAY_READY" }
  | { type: "USER_SPEECH_STARTED" }
  | { type: "USER_SPEECH_ENDED" }
  | { type: "TURN_COMMITTED"; turnId: string; text: string }
  | { type: "AGENT_ACTIVITY"; activity: AgentActivity }
  | { type: "AGENT_TEXT_STARTED"; turnId: string }
  | { type: "TTS_PLAYBACK_STARTED"; turnId: string }
  | { type: "TTS_PLAYBACK_ENDED"; turnId: string }
  | { type: "AGENT_TURN_DONE"; turnId: string }
  | { type: "BARGE_IN_DETECTED" }
  | { type: "TRANSPORT_LOST" }
  | { type: "TRANSPORT_RECOVERED" }
  | { type: "END_REQUESTED" }
  | { type: "FATAL_ERROR"; error: CordError }
  | { type: "CLEANUP_COMPLETE" };
```

## 5. Core transitions

```text
IDLE
  └─ START_REQUESTED → PREPARING

PREPARING
  ├─ SESSION_CREATED → CONNECTING
  ├─ END_REQUESTED → ENDING
  └─ FATAL_ERROR → FAILED

CONNECTING
  ├─ ready → LISTENING
  ├─ TRANSPORT_LOST → RECONNECTING
  ├─ END_REQUESTED → ENDING
  └─ FATAL_ERROR → FAILED

LISTENING
  ├─ USER_SPEECH_STARTED → USER_SPEAKING
  ├─ TRANSPORT_LOST → RECONNECTING
  └─ END_REQUESTED → ENDING

USER_SPEAKING
  ├─ USER_SPEECH_ENDED → TURN_COMMITTING
  ├─ TRANSPORT_LOST → RECONNECTING
  └─ END_REQUESTED → ENDING

TURN_COMMITTING
  ├─ TURN_COMMITTED → AGENT_WORKING
  ├─ USER_SPEECH_STARTED → USER_SPEAKING if not committed
  └─ FATAL_ERROR → FAILED

AGENT_WORKING
  ├─ TTS_PLAYBACK_STARTED → AGENT_SPEAKING
  ├─ AGENT_TURN_DONE → LISTENING
  ├─ USER_SPEECH_STARTED → USER_SPEAKING
  ├─ TRANSPORT_LOST → RECONNECTING
  └─ END_REQUESTED → ENDING

AGENT_SPEAKING
  ├─ BARGE_IN_DETECTED → INTERRUPTING
  ├─ playback done + agent done → LISTENING
  ├─ TRANSPORT_LOST → RECONNECTING
  └─ END_REQUESTED → ENDING

INTERRUPTING
  ├─ speech stopped + user active → USER_SPEAKING
  ├─ false positive → AGENT_SPEAKING
  └─ FATAL_ERROR → FAILED

RECONNECTING
  ├─ TRANSPORT_RECOVERED → prior safe state
  ├─ recovery timeout → FAILED
  └─ END_REQUESTED → ENDING

ENDING
  └─ CLEANUP_COMPLETE → ENDED
```

## 6. Compound readiness

`CONNECTING → LISTENING` requires both media and gateway/provider/adapter readiness sufficient to accept a turn.

Do not show `Connected` prematurely.

## 7. Interrupted generation

Entering `INTERRUPTING`:

- invalidate active `speechGenerationId`;
- discard late audio from that generation;
- clear queued speech chunks;
- optionally request adapter cancellation;
- do not wait indefinitely for agent cancellation before listening to user.

**As built (ADR-015):** INTERRUPTING is instantaneous on the gateway, never a phase the phone shows. On STT's confident speech-start over the agent's speech, the gateway cancels the TTS generation, clears queued audio, drops that generation's late audio, and moves the floor straight to `user_speaking`. The interrupted turn is muted for good: if the caller's speech proves to be noise, the rest of the answer is shown as text but never spoken. The agent run is cancelled only when the caller's new turn commits (the supersede path), not at barge-in.

## 8. User speaks while agent is working

Valid sequence.

Twring starts a new user turn and may request prior generation cancellation. The connected agent remains responsible for external action semantics.

## 9. Reconnect snapshot

```ts
type ReconnectSnapshot = {
  previousState: ActiveCallState;
  activeUserTurnId?: string;
  activeAgentTurnId?: string;
  activeSpeechGenerationId?: string;
  lastAdapterSeq?: number;
};
```

Never blindly resume old audible speech if the user has already started another turn.

## 10. Timeouts

Use named, observable configuration:

- prepare timeout;
- media connect timeout;
- gateway ready timeout;
- adapter connect timeout;
- reconnect budget;
- provider idle timeout.

No magic timeout numbers scattered in feature code.

## 11. Stable error codes

Examples:

```text
CALL_AUTH_FAILED
CALL_SESSION_CREATE_FAILED
LIVEKIT_CONNECT_FAILED
MIC_PERMISSION_DENIED
MIC_UNAVAILABLE
STT_UNAVAILABLE
TTS_UNAVAILABLE
AGENT_CONNECT_FAILED
AGENT_PROTOCOL_INVALID
AGENT_TIMEOUT
NETWORK_LOST
RECONNECT_EXHAUSTED
UNKNOWN_CALL_FAILURE
```

Provider-specific error text maps to Twring codes.

## 12. Invariants

- at most one committed send per `turn_id`;
- audible TTS belongs to current valid speech generation;
- ENDED/FAILED never return to active state;
- END_REQUESTED eventually terminates;
- reconnect does not create a new logical call ID;
- UI derives from state machine, not independent loading flags.

## 13. Testing

Use table-driven reducer tests for all legal transitions plus invalid transitions.

In development, invalid transitions should emit diagnostics. In production, recover safely where possible.

## 14. User-facing state mapping

| State | Default label |
|---|---|
| PREPARING | Starting call… |
| CONNECTING | Connecting… |
| LISTENING | Listening |
| USER_SPEAKING | Listening |
| TURN_COMMITTING | … |
| AGENT_WORKING | Working… |
| AGENT_SPEAKING | Speaking |
| INTERRUPTING | Listening |
| RECONNECTING | Reconnecting… |
| ENDING | Ending… |
| FAILED | Call interrupted |

Do not expose internal protocol jargon.
