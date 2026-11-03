# Twring Observability and SLOs

## 1. Why this matters

A voice product can be technically “up” and still feel broken.

Twring measures perceived call quality, not only server availability.

## 2. Golden signals

- call start success;
- media connection success;
- STT availability;
- agent availability;
- TTS availability;
- speech-end to first-audio latency;
- interruption latency;
- reconnect success;
- error rate;
- crash-free sessions.

## 3. Initial engineering targets

These are internal starting targets, not contractual user promises. Tune with beta data.

### Tap Call → active listening

- p50 < 2.0s
- p95 < 4.0s

### User speech end → committed turn

- p50 < 450ms
- p95 < 900ms

### First useful agent text → first TTS audio

- p50 < 350ms
- p95 < 800ms

### Barge-in detected → audible agent stop

- p50 < 200ms
- p95 < 400ms

Agent response latency itself is measured separately because the connected agent is external.

## 4. End-to-end perceived latency

Primary metric:

```text
user_speech_ended → audio_first_published
```

Breakdown:

```text
endpoint detection
+ connected-agent first response
+ TTS first byte
+ media playout
```

This prevents blaming “the model” for infrastructure delay.

## 5. Telemetry events

Emit structured events:

```text
call_created
livekit_connect_started
livekit_connected
gateway_ready
stt_connected
agent_connected
user_speech_started
user_speech_ended
turn_committed
agent_first_event
agent_first_text
tts_first_audio
agent_audio_published
barge_in_detected
tts_cancelled
transport_lost
transport_restored
call_ended
call_failed
```

## 6. Correlation fields

Where applicable:

- environment;
- release;
- request_id;
- call_id;
- session_id;
- agent_id;
- turn_id.

Never use transcript text as correlation data.

## 7. Metrics

Counters:

- calls_started;
- calls_connected;
- calls_failed;
- turns_committed;
- adapter_errors;
- stt_errors;
- tts_errors;
- reconnect_attempts;
- reconnect_successes;
- barge_ins.

Histograms:

- call_connect_ms;
- turn_commit_ms;
- agent_first_event_ms;
- tts_first_audio_ms;
- end_to_audio_ms;
- barge_in_stop_ms;
- reconnect_ms;
- call_duration_ms.

Gauges:

- active_calls;
- gateway_sessions;
- provider_connections.

## 8. Provider tags

Tag provider names and adapter type, but never credentials/account keys.

## 9. Tracing

A turn trace should resemble:

```text
turn
├─ stt.finalize
├─ adapter.send
│  ├─ first_event
│  └─ done
├─ tts.first_chunk
└─ audio.publish
```

High-latency/error calls should be preferentially sampled if sampling is introduced.

## 10. Safe logs

Example:

```json
{
  "event": "turn_committed",
  "call_id": "call_...",
  "turn_id": "turn_...",
  "text_chars": 42,
  "words": 8,
  "speech_ms": 4200,
  "quiet_ms": 1200,
  "turn_commit_ms": 318
}
```

`speech_ms` runs from the start of the caller's speech to the commit (so it includes the wait after the
last word); `quiet_ms` is how long the words had stopped changing before the commit. Talking time is
about `speech_ms - quiet_ms`. A caller whose audio stops arriving for 5 s mid-call (not muted, the
gateway not reconnecting) logs `caller_audio_stalled` once, and `caller_audio_resumed` with
`stalled_ms` when it comes back.

Do not log the transcript content by default.

## 11. Mobile observability

Sentry captures crashes/native crashes/app hangs where supported, navigation breadcrumbs, call-state breadcrumbs, release/environment, and safe correlation IDs.

No raw audio/transcript.

## 12. Launch dashboard

Must show:

- calls started/connected;
- failure codes;
- end-to-audio percentiles;
- barge-in latency;
- provider error rates;
- reconnect rates;
- active calls;
- crash-free sessions.

## 13. Alerts

Alert when:

- call start success drops significantly;
- provider auth fails globally;
- gateway errors spike;
- p95 latency regresses materially;
- core auth/database unavailable.

Do not alert on every user's broken custom endpoint.

## 14. Synthetic checks

Periodic staging checks:

- API health;
- fake-adapter call setup;
- streamed turn;
- optional bounded-cost provider smoke test.

## 15. Release comparison

Every RC compares call connect, end-to-first-audio, barge-in, and crash rate against previous stable build.

Block major unexplained regressions.

## 16. Cost telemetry

Monitor provider usage per call and detect anomalies such as TTS after call end, stuck STT, duplicate gateway worker, runaway call duration.

### Usage telemetry as built (Milestone 8)

The gateway measures each call itself and, when the call ends, writes one `call_usage` log line (after `call_ended`/`call_failed`) and stores the same summary as `usage` on the call-history row (`CallHistoryItem.usage`, optional). Counts and durations only; never transcript text.

| Field | Meaning |
| --- | --- |
| `stt_audio_s` | Audio streamed to STT, including keepalive silence (what Flux bills). |
| `stt_connected_s` | Time an STT session was open (reconnect gaps excluded). |
| `tts_chars` | Characters of agent text sent to TTS. |
| `tts_audio_s` | Synthesized audio received from TTS (48 kHz linear16), including audio later cut by a barge-in. |
| `agent_turns`, `agent_turns_completed`, `agent_turns_failed` | Turns sent to the agent; completed/failed (timeouts count as failed). Superseded turns are the remainder. |
| `barge_ins` | Confirmed barge-ins that cut agent speech. |
| `gateway_connected_s` | Gateway participant time in the room: the room/participant-minutes estimate (the caller's minutes are about the same). |
| `stt_reconnects`, `tts_reconnects` | Successful provider reconnects. |
| `estimated_cost_usd` | Only when at least one rate is set. |

Cost rates come from config, in USD, and default to 0 (unknown, left out of the estimate): `CORD_RATE_STT_PER_MIN` (per streamed STT audio minute), `CORD_RATE_TTS_PER_1K_CHARS`, `CORD_RATE_ROOM_PER_MIN` (per gateway-connected minute; set it per call-minute if you want both participants priced). Twring ships no vendor prices: they change and depend on contracts, so the estimate is only as good as the rates you set.

`CallHistoryRepository.usageRollup(userId, sinceDay?)` sums usage per UTC day and agent for later dashboards. It covers only the history still kept (200 calls per user in the V1 store); a Supabase `usage_records` table (DATA_MODEL §8) replaces it when billing needs full history.

### Long calls (Milestone 8 audit)

- LiveKit: tokens are checked only at join. The server refreshes tokens for connected participants, so the caller's 10-minute token and the gateway's call-length token do not end a long call; a caller that fully rejoins after `CALL_TOKEN_TTL_S` relies on the SDK's refreshed token.
- Deepgram STT: streams close after about 10 s without audio. Caller frames stop while the phone is muted or away, so the pipeline sends 100 ms of silence after 4 s without audio (`STT_IDLE_KEEPALIVE_MS`). No maximum Flux session length is documented; a drop is handled by the reconnect path (an utterance in progress is reported discarded, never half-committed), so no proactive reconnect is scheduled.
- Deepgram TTS: WebSocket ping every 20 s (Flux TTS drops sessions idle 60 s).
- Reconnects: delays 250 ms, 1 s, 3 s, then the call fails. The budget is restored only after a reconnected session stays up 10 s (`RECONNECT_STABLE_MS`), so a provider that accepts and drops at once cannot reconnect-storm forever.
- Per-call state is bounded: playout history (8 generations), echo-window generations (pruned after their tail), TTS started turns (8), per-turn timers, and the output queue (one minute of speech). A 60-minute soak test (`apps/gateway/src/calls/reliability.test.ts`) asserts this and that hang-up leaves no timers.

## 17. Privacy

Observability is not transcript storage.

Content-level diagnostic capture, if ever introduced, requires explicit opt-in and strong expiry.

## 18. Healthy-call definition

A healthy call connects, receives user audio, commits a turn, obtains an agent result, produces audible output, allows interruption, and closes resources correctly.
