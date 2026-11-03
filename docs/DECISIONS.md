# Twring Architecture Decision Log

This file records foundational decisions that should not drift silently.

## ADR-001: React Native + Expo development builds

**Status:** Accepted  
**Date:** 2026-09-24

Twring launches Android first but must remain iOS-friendly and needs native WebRTC/audio. Use React Native + Expo development builds, not Expo Go. Prefer config plugins/CNG where practical.

Revisit only if a required call/audio capability cannot be delivered reliably through this path.

---

## ADR-002: LiveKit is V1 media transport

**Status:** Accepted  
**Date:** 2026-09-24

Use LiveKit Cloud first for WebRTC/media/session transport rather than building raw signaling/TURN/reconnect infrastructure.

Self-hosting remains a later option if cost/compliance/reliability requires it.

---

## ADR-003: Cascaded voice; no S2S agent authority

**Status:** Accepted  
**Date:** 2026-09-24

Use streaming STT → connected agent → streaming TTS.

No speech-to-speech model controls the connected agent's tools/actions.

---

## ADR-004: Deepgram first voice provider

**Status:** Accepted  
**Date:** 2026-09-24

Use Deepgram Flux STT and Deepgram streaming/Aura TTS first, behind replaceable provider interfaces.

---

## ADR-005: Native WebSocket + REST/SSE launch adapters

**Status:** Accepted  
**Date:** 2026-09-24

Launch adapter priority:

1. Twring Native WebSocket;
2. REST/SSE;
3. AG-UI compatibility when schedule allows;
4. A2A later.

MCP remains normally agent-to-tool.

---

## ADR-006: TypeScript-first backend

**Status:** Accepted  
**Date:** 2026-09-24

Node.js + TypeScript for V1 backend/gateway to share contracts and reduce cognitive/operational complexity.

---

## ADR-007: Supabase for V1 persistence/auth path

**Status:** Accepted  
**Date:** 2026-09-24

Use Supabase Postgres and likely Supabase Auth for the shortest reliable V1 path while keeping domain contracts provider-neutral.

---

## ADR-008: No raw audio retention by default

**Status:** Accepted  
**Date:** 2026-09-24

Twring does not persist raw call audio by default. Transcript retention is explicit/disclosed.

---

## ADR-009: Simple pnpm workspace

**Status:** Accepted  
**Date:** 2026-09-24

Use pnpm workspaces without Nx/Turborepo initially. Revisit only after measured build/task pain.

---

## ADR-010: Workspace build conventions (Milestone 0)

**Status:** Accepted\
**Date:** 2026-09-24

- pnpm uses `nodeLinker: hoisted`; Metro and Gradle autolinking expect a flat `node_modules`.
- Internal packages (`@twring/*`) export TypeScript source, not build output. Metro compiles them for mobile; the gateway is bundled by esbuild into `dist/main.js` with `@twring/*` inlined and third-party dependencies external. No per-package build step.
- TypeScript is pinned to 6.0.x: it is the version Expo SDK 57 ships with and the newest typescript-eslint supports. Move to 7.x in a dedicated upgrade task.
- Mobile identity is selected by `APP_VARIANT` (development/staging/production → `.dev` / `.staging` / no suffix) so builds coexist on one device. Backend selection is separate (`EXPO_PUBLIC_CORD_ENV`).

**Open product decision:** the base identifier `com.saasagelabs.cord` is a placeholder. The Android package name is permanent after the first Play upload, so confirm it before Milestone 11.
Decided 2026-10-07: `com.twring.app` (owner).

---

## ADR-011: Codemagic replaces GitHub Actions for CI

**Status:** Accepted\
**Date:** 2026-09-25

- **Requirement:** CI must run lint, types, and tests, produce an installable Android APK, and compile iOS on every PR (TECH_STACK minimum CI; BUILD_ORDER "CI green").
- **Why not GitHub Actions:** the account's Actions are blocked by billing, so no jobs start. Codemagic's free `mac_mini_m2` machine builds both Android and iOS, and on PR #1 its Verify, Android APK, and iOS simulator workflows passed.
- **Decision:** `codemagic.yaml` is the only CI. The `.github/workflows/` files are removed so PRs don't show checks that can never run.
- **Operational cost:** a monthly free-minute budget shared by all workflows, and a one-time Codemagic app connection to the GitHub repo. Mobile workflows skip changes that can't affect the app.
- **Rollback:** restore `.github/workflows/` from git history once Actions billing works. The workflows only call root `pnpm` scripts, so they stay interchangeable.

---

## ADR-012: Interim call API without user auth (Milestones 1–6)

**Status:** Accepted\
**Date:** 2026-09-25

- **Requirement:** Milestone 1 needs a phone to create a real call before auth exists (auth is TWR-101, Milestone 7). SECURITY §12 requires that only an authenticated session can mint call tokens.
- **Decision:** until Milestone 7, `POST /v1/calls` is unauthenticated. It is bounded by: the `CALLS_ENABLED` kill switch, a per-IP rate limit, a concurrent-call cap, a maximum call duration, and caller tokens that expire in 10 minutes, can join only that call's room, and can publish only a microphone (no data, no metadata, no admin). Calls are addressed by 100-bit random IDs. The request body is strict, so a client-supplied `user_id` is rejected.
- **Also decided:** the call API and the gateway participant run in one Node process (BACKEND_SPEC §1). The call state reducer lives in `@twring/contracts` so mobile and gateway share one definition.
- **Consequences:** staging must not be publicly advertised. Anyone who finds the URL can spend LiveKit minutes up to the caps. The gateway connects to no user-provided endpoints yet, so there is no SSRF surface.
- **Rollback / exit:** Milestone 7 adds Supabase auth to `/v1/calls*`, scopes calls to their owner, and adds the authz tests in SECURITY §12. This ADR is superseded then.

---

## ADR-013: Deepgram Flux TTS (`/v2/speak`) as the first TTS

**Status:** Accepted\
**Date:** 2026-09-26

- **Context:** ADR-004 chose Deepgram streaming/Aura TTS. Since then Deepgram shipped Flux TTS on `/v2/speak`, alongside the unchanged Aura `/v1/speak`. It is built for voice agents: streamed text in, a per-turn lifecycle, and an `Interrupt` message that cancels the active turn and reports what the listener heard (`text_spoken`).
- **Decision:** use Flux TTS over WebSocket, as raw 48 kHz linear16 (LiveKit's native rate, so no resampling), with default voice `flux-haley-en`. One Flux turn is one Twring speech generation. Flux STT (`flux-general-en`, `/v2/listen`) is unchanged from ADR-004.
- **Why:** barge-in (Milestone 4) needs cancellation and "what did the user actually hear" reconciliation. Flux TTS provides both, so Twring doesn't have to approximate them.
- **Consequences:** voices are English-only for now. Both providers stay behind Twring's `SttProvider`/`TtsProvider` interfaces, so swapping back to Aura, or to another vendor, touches only `apps/gateway/src/voice/deepgram-*.ts`. Transport is plain WebSockets (`ws`), with no Deepgram SDK.
- **Revisit when:** a non-English launch market, a Flux TTS quality or latency problem measured on devices, or pricing changes.

---

## ADR-014: The gateway owns the conversational floor; agent text streams straight into Flux TTS

**Status:** Accepted\
**Date:** 2026-09-26

- **Context:** Milestone 3 adds the conversational call states (USER_SPEAKING, AGENT_WORKING, AGENT_SPEAKING). The events that drive them (end of turn, agent events, first audio published, playout finished) all happen on the gateway, while the phone renders the state. VOICE_ARCHITECTURE §9 also describes sentence/clause chunking for TTS. Flux TTS (ADR-013), though, takes a turn's text as a token stream and places its own synthesis boundaries.
- **Decision:**
  - The gateway's `ConversationController` is authoritative for who has the floor. It sends the whole floor (`listening | user_speaking | agent_working(activity) | agent_speaking`, with `turn_id` and a monotonically increasing `seq`) as a reliable `floor` status message on every change. The phone keeps the highest `seq` it has seen, applies it with one reducer event, `FLOOR_CHANGED`, while connected, and re-applies it on reconnect.
  - The floor returns to `listening` only after the agent is done and the answer's last audio frame has been published.
  - Agent text goes to TTS through `SpeechTextFilter`, which releases whole words, holds back incomplete links, and drops markdown syntax, code blocks, URLs, and HTML. It does not split into sentences: that is Flux's job.
- **Why:** a full-state message with `seq` is idempotent and self-correcting after a lost or late packet. Edge events (START/ENDED pairs) can leave the phone stuck in a stale state. Sentence chunking on top of Flux would only add latency before the first audio.
- **Consequences:**
  - The phone doesn't validate conversational transitions itself; the gateway's controller is tested instead.
  - TURN_COMMITTING is not a separate phase, because Flux's end-of-turn is the commit.
  - Until barge-in (Milestone 4, ADR-015), caller speech while the agent holds the floor doesn't change the floor. A committed turn supersedes the answer: speech stops, the agent run is aborted, and `cancelTurn` is sent when supported.
  - A TTS vendor without streamed-text input would need a sentence chunker behind the `TtsSession` interface.
- **Revisit when:** a non-streaming TTS vendor is added, or measured floor lag on devices exceeds the UX budget.

---

## ADR-015: Barge-in: stop at once, never resume, cancel the agent only on a committed turn

**Status:** Accepted\
**Date:** 2026-09-26

- **Context:** Milestone 4 makes the call interruptible. VOICE_ARCHITECTURE §10 and CALL_STATE_MACHINE §5–7 describe an INTERRUPTING state with a false-positive path back to AGENT_SPEAKING; UX_UI_SPEC §14 says audio stops immediately with no "Cancelling…" state. Flux STT's `speech_started` is already a confident start of a user turn, and the caller may only be backchannelling ("uh-huh") rather than taking a turn.
- **Decision:**
  - When STT reports speech-start while the agent's speech generation exists (playing or still being synthesized), a barge-in is pending: speech and floor are unchanged. It is confirmed by the first STT partial that is not echo of the agent's own speech (see below); the gateway then cancels that generation, clears queued audio (`clearOutput`), and moves the floor straight to `user_speaking`. There is no INTERRUPTING phase on the phone. A discard clears a pending barge-in.
  - Echo rejection (amended 2026-09-26, device evidence: on a loud speakerphone with the phone's hardware AEC on, residual echo of the agent's voice reached Flux, fired speech-start and cut the agent off while the caller was silent; sometimes the echo was even committed and superseded the answer. Reworked the same day to judge only what is audible now, after a verifier showed turn-wide memory swallowing real speech). **Audible window:** the pipeline reports per generation how much audio has played (`playedMs`, counted as each queued chunk's last frame is published) and, once TTS is done, its total length (`totalAudioMs`). The controller keeps each generation's speakable text and estimates the text position being heard as `playedMs × rate` (rate = characters ÷ total audio once known, else 14 chars/s). The echo window is the text from `ECHO_LOOKBACK_MS` (4 s) before that position to `ECHO_LOOKAHEAD_MS` (1 s) after it, widened by ±15% of the position for rate error but at most `ECHO_MAX_SLACK_MS` (2 s) of audio, expanded to whole words. A cut generation keeps its window (at the cut) for `ECHO_TAIL_MS` (1 s); a generation that played out in full keeps only its last `ECHO_LOOKBACK_MS` of text (known rate, no slack) for `ECHO_FINISHED_TAIL_MS` (500 ms) after its last frame, so a prompt answer to a closing question is the caller's. Then it drops out. Words not yet near the playout position, or heard longer ago, are never echo. **Audible start:** only an utterance whose speech-start came while the agent was audible (a generation playing, or within its tail) can be echo; anything else (e.g. answering the agent's question after it stopped) is never judged. **Tail judging:** each partial is judged only on the words new since the previous partial of the same utterance (the whole partial when it is not an extension of the previous one). The new words are echo iff every word is in the window and, for 3+ words, at least 60% of their word pairs are too; otherwise the utterance is real and a pending barge-in is confirmed. **Per-utterance confirmation:** once any partial is judged not echo, the utterance is real and its commit is never dropped. A commit of a still-unconfirmed audible-start utterance is stripped of its leading run of window words in the agent's order (STT may drop up to 2 words between them); if nothing remains it is dropped as if it were noise (no agent call, no supersede, held speech released), otherwise it commits normally, confirming the barge-in first. Per generation, the utterance keeps one continuous span of text (the earliest start and latest end audible while it was live), so a long echo commit spanning several windows matches as one run, and a commit that lands after the tail has expired is still judged against what was audible. **Normalisation** (both sides): lowercase, curly/straight apostrophes, 0–99 as words, ok/okay, a.m./p.m., % as "percent", hyphen variants ("e-mail" = "email", "follow-up" = "follow up"; a digit range "3-5" = "three to five"), common contractions expanded (it's, don't, I'm, you're, can't, won't, …). Logged as `echo_rejected` (`phase`, `words`, `overlap`; never the text).
  - The interrupted turn is muted: nothing more from it is ever spoken, even if the caller's speech is later discarded as noise. Its later text still reaches the phone as `agent_text`. The turn completes when the agent is done.
  - The agent run is not aborted at barge-in. It is aborted (and `cancelTurn` sent when supported) only when the caller's new turn commits, through the existing supersede path.
  - When the caller talks over a working agent that is not yet speaking, the floor goes to `user_speaking` and the agent's speakable text is held. If the caller's speech is discarded, the held text is spoken; if their turn commits, it is dropped with the superseded turn. An STT drop mid-utterance counts as a discard: the utterance is gone and no commit will come for it.
  - A speech generation is closed at each tool/activity boundary: the words so far are flushed and ended, and text that arrives while they are still playing out is held until they finish, then starts the next generation. Once the preamble has played, the floor shows `agent_working` with the activity, and caller noise during the silent tool call only holds speech; it is not a barge-in and does not mute the answer that follows. Caller speech while the ended preamble is still playing is a barge-in as before.
  - Telemetry: `barge_in` (turn, generation, `detect_ms` from the first caller frame above -35 dBFS while speech was active to speech-start, `confirm_ms` from speech-start to the confirming partial), `tts_cancelled` with a `reason`, and `tts_stopped` with `dropped_ms` (queued speech audio the barge-in discarded before it was heard). No transcript content is logged.
  - Flux TTS interrupt protocol (observed 2026-09-26 with `scripts/flux-tts-probe.ts`, `flux-haley-en`, `/v2/speak`):
    - Every turn (the text one Twring generation sent between boundaries) gets exactly one `SpeechStarted{speech_id}`, in the order turns were started, even if it is interrupted before any audio or never flushed. `Flushed{speech_id}` follows it.
    - Every `Interrupt` gets exactly one `SpeechInterrupted{audio_played_ms, metadata.speech_id}`, in order; the id is nested under `metadata`.
    - A cut turn never gets `SpeechMetadata`; a completed turn gets `SpeechMetadata{speech_id}` after its last audio.
    - Audio between an `Interrupt` and its `SpeechInterrupted` belongs to the cut turn; the next turn's `SpeechStarted` always arrives after that `SpeechInterrupted`.
    - No `Warning` was seen in any interrupt scenario. Interrupting with nothing playing is acked with `SpeechInterrupted` for the last completed turn; Twring never sends that Interrupt.
    - So the gateway routes by turn order: each `SpeechStarted` is the oldest generation not yet started, audio is delivered only while that generation is the active, uncancelled one, and `SpeechMetadata` completes only the generation it names. Interrupt acknowledgements only drive the 2 s ack timeout (`INTERRUPT_ACK_TIMEOUT_MS`); warnings do not affect routing.
- **Why:** audible speech stopping at once is what makes it feel like a call. Resuming a cut-off answer after a false positive sounds broken and is hard to do cleanly mid-sentence. Keeping the agent running until a turn commits avoids discarding its work for a cough or a backchannel.
- **Consequences:**
  - Backchannels ("uh-huh", "right") also stop the answer, and it does not resume; the text remains on screen.
  - Held text over a working agent can delay its speech by the length of the caller's noise.
  - Echo cancellation on the phone is still required (VOICE_ARCHITECTURE §11); gateway echo rejection only catches residual echo that STT transcribes as the agent's words.
- **Known limits:**
  - `detect_ms` starts at the first caller frame above -35 dBFS, so steady background noise above that level while the agent speaks sets the onset early and inflates it.
  - LiveKit may still play one in-flight 20 ms frame after `clearQueue`.
  - An Interrupt Flux does not acknowledge within 2 s (`INTERRUPT_ACK_TIMEOUT_MS`) costs a TTS reconnect: the session is dropped. A `NOTHING_TO_INTERRUPT` warning settles the oldest pending Interrupt; other warnings are ignored.
  - Routing relies on Flux keeping one `SpeechStarted` per turn in start order; a protocol change there would misroute audio until the next reconnect.
  - `dropped_ms` counts only speech queued in the gateway. The LiveKit `AudioSource` queue (~200 ms, `OUTPUT_QUEUE_MS`) and the in-flight frame are dropped too but not counted.
  - The playout position is an estimate: at 14 chars/s until TTS reports the total, then the generation's average rate. Speech much faster or slower than average in part of a generation shifts the window (the ±15% slack, capped at 2 s, absorbs modest error).
  - A caller who answers within `ECHO_FINISHED_TAIL_MS` of the agent's last frame (as handed to LiveKit) with words from its last ~4 s is still dropped as echo.
  - STT mishearing echo (one wrong word) is not echo: it can still confirm a false barge-in and cut the answer.
  - A caller repeating the words the agent is saying right now (within the audible window) is treated as echo: a barge-in waits for a different word, and a commit made only of them is dropped.
  - Confirmation adds the time to the first partial to barge-in latency (usually small: Flux tends to carry a partial with StartOfTurn).
  - A caller who starts speaking within ~200 ms after a preamble's last frame was handed to LiveKit only holds the agent's next words, not cuts them: the preamble has already reported finished.
- **Revisit when:** device testing shows backchannels or echo cutting answers too often. Options: a minimum-words check, or a semantic backchannel check, before muting.

---

## ADR-016: CI within a fixed macOS budget

**Status:** Accepted (amends ADR-011)\
**Date:** 2026-09-26

- **Context:** by Milestone 4, 300 of the month's 500 free Codemagic macOS minutes were used. Every workflow ran on `mac_mini_m2` (Verify ~1.5 min, Android ~10 min, iOS ~21 min) and ran twice per milestone: on the PR and again on the push to `main`. The owner asked to finish Milestones 4–11 on the remaining 200 minutes. Moving Linux work to GitHub Actions was approved, but the account's Actions jobs are still refused before they start ("recent account payments have failed or your spending limit needs to be increased", checked 2026-09-26).
- **Decision:**
  - Codemagic runs only on PRs to `main`; the rerun on merge is removed.
  - `verify` runs on every PR.
  - `ios-build-check` runs only when native inputs change (mobile `package.json`, `app.config.ts`, root manifests and lockfile, `codemagic.yaml`) and compiles only the arm64 simulator slice.
  - `android-apk` is manual-only; phone testing uses local Gradle builds.
  - Amended 2026-09-26: `ios-build-check` is manual-only too. A changeset `when` still boots a Mac just to skip (~2.4 min billed on PR #5), so it is started by hand when native inputs change.
  - `.github/workflows/verify.yml` and `android.yml` exist but are manual-only until Actions billing works. Then they take over Verify and the APK, and Codemagic keeps only iOS.
- **Budget:** about 1.5 min of Verify per PR push, plus about 5–7 iOS runs at an estimated 10–12 min each, through Milestone 11: roughly 95 of the 200 minutes.
- **Revisit when:** GitHub Actions billing is cleared, or the Codemagic budget resets or changes.

**Amended 2026-11-03:** with the repository public, every CI job runs on GitHub Actions (Linux and macOS runners are free for public repositories), including the signed TestFlight build (protected environment, stored distribution certificate). Codemagic is retired.

---

## ADR-017: Floor-control words and short barge-in grace

**Status:** Accepted (amends ADR-015)\
**Date:** 2026-09-27

- **Context:** a device capture (2026-09-27, owner consented, since deleted), replayed through four Flux configurations, showed that the first word of an interruption is spoken while the agent's voice still plays on speakerphone, and AEC double-talk clips it: a lone "wait" was heard as "Rate", "Right?", "Rick", "late"; "stop" as "stuff". Repeated words ("Wait. Wait.", "Stop. Stop.", "Hold on. Hold on.") were recognized perfectly, because the agent had already stopped. Keyterms fixed "stuff" → "stop" only; no configuration fixed the first "wait". On the call the barge-in cut worked, but the agent was sent one-word nonsense turns ("Rate,", "Right?") and answered them.
- **Decision:**
  1. STT always favours the interruption words `INTERRUPTION_KEYTERMS` (wait, stop, hold on, hang on, one second). `DEEPGRAM_STT_KEYTERMS`, when set, comes first; the defaults are appended, deduped, within Deepgram's 50-term cap.
  2. A committed utterance that confirmed a barge-in (it started while the agent was audible and cut the answer) and consists only of `FLOOR_CONTROL_WORDS` (wait, stop, hold on, hang on, one second, one sec, pause, shh, sorry, excuse me; repetitions allowed) is not sent to the agent. The floor goes to listening; `floor_control` is logged with a word count. A still-running agent turn is **not** cancelled: the caller asked it to stop talking, not to stop working. It runs on muted (its text still reaches the phone) until it finishes, or the caller's next real turn supersedes it as usual.
  3. A barge-in utterance of 1–2 words that is not all floor-control words is held for `SHORT_BARGE_IN_GRACE_MS` (1500 ms). If the caller's next utterance commits, the held text is prepended to it (same `MAX_MERGED_TURN_CHARS` cap), even if the grace ran out while they were talking. Noise does not end the hold. With no new words by the end of the grace, the held text is sent alone. The floor shows listening / user_speaking during the grace, never agent_working. `short_turn_held` and `short_turn_released` {words, merged} are logged, counts only.
  4. Only barge-in utterances get (2) and (3).
  5. (Follow-up, 2026-09-27.) If the utterance that follows a held short text within the grace is only floor-control words ("Rate," then "Wait."), both are dropped: nothing is sent, the floor goes to listening, `floor_control` is logged.
  6. (Follow-up, 2026-09-27.) The "keep talking" merge of an unheard superseded turn into the next never re-sends a turn that may have acted: it is skipped when the superseded turn finished, reported activity or tool events, or its adapter does not declare tool events (AGENT_ADAPTER_SPEC §6). Never replay a non-idempotent action. A turn spoken while the agent is silent, such as a short "yes" to a question it finished asking, is sent at once as before.
- **Consequences:** a caller who says only "stop" gets silence and the floor, not a reply. A real 1–2 word reply spoken over the agent is delayed by up to 1.5 s. The word list is English-only.
- **Revisit when:** Twring supports languages other than English, or device data shows the grace delays real replies noticeably.

**Amendment (2026-10-16):** Short normal turns of 1–2 words, excluding stop requests and floor-control-only words, are held for `SHORT_TURN_HOLD_MS` (default 800 ms; 0 disables it), so a breath after "okay" does not split a sentence. The barge-in grace remains unchanged.

---

## ADR-018: Auth deferred; file-backed store + app-level encrypted credentials until Supabase

**Status:** Accepted; decision 1 superseded by ADR-021**Date:** 2026-09-27

- **Context:** Milestone 7 needs saved agents, their credentials, and call history. The owner deferred auth. The gateway will first run as a single Node process on a Lightsail Ubuntu box, with no separate database server.
- **Decision:**
  1. Every request acts as one local user, `dev-user`, resolved on the server (never from the request body). Rows still carry `user_id` and every query is scoped by it.
  2. Storage sits behind provider-neutral repository interfaces (`AgentRepository`, `CredentialVault`, `CallHistoryRepository`). V1 implements them as JSON files under `CORD_DATA_DIR`, one per collection, written to a temp file and renamed, serialized by a per-process mutex. Tests use in-memory collections.
  3. Credentials are encrypted in the gateway with AES-256-GCM: key from `CORD_CREDENTIALS_KEY` (32 bytes, base64; required outside development, never generated automatically), random 12-byte IV per secret, `key_version` stored for rotation (`CORD_CREDENTIALS_OLD_KEYS` keeps old versions readable), AAD = user id + agent id. The API never returns a credential; deleting an agent deletes its credential first.
  4. A saved agent's credential is decrypted only inside the gateway process, when its call or connection test connects.
- **Consequences:** one gateway process only (the lock is per process); no multi-user access until auth lands; the data folder and the key must be backed up separately. The `/v1` API shapes do not change when Supabase replaces the files.
- **Revisit when:** auth lands (Supabase Auth + Postgres with RLS; move the key to a secret manager), or a second gateway process is needed.

---

## ADR-019: Background calling: own minimal Android foreground service; iOS `audio` background mode only

**Status:** Accepted**Date:** 2026-09-28

- **Context:** Milestone 8 needs a call to survive the screen turning off and the app going to the background. Until now the call screen kept the display awake as a workaround. LiveKit's React Native docs point Android apps at a foreground service (their example uses `@supersami/rn-foreground-service`) and iOS apps at the `audio` (and optionally `voip`) background modes.
- **Decision:**
  1. **Android:** a local Expo module, `apps/mobile/modules/cord-call-service` (about 150 lines of Kotlin, no config plugin: its own manifest merges in). It runs a foreground service of type `microphone` that owns no media. It only keeps the process allowed to capture audio with the screen off, and shows an ongoing notification ("Twring call in progress · agent name") whose End action hangs up through the same path as the on-screen button. Permissions: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS` (asked once per app run, just before connecting; a denial only hides the notification).
  2. The controller starts the service when the call first reaches LISTENING and stops it on every end path (`release()`: hang-up, failure, server end, hang-up during connect), after any in-flight start settles. A refused start (Android will not start one from the background) is logged as `background_start_failed` and the call continues.
  3. **iOS:** `UIBackgroundModes: ['audio']` and nothing broader. LiveKit's default session (`playAndRecord` / `voiceChat`, speaker by default) keeps audio running while locked.
  4. The keep-awake workaround is removed: the screen may turn off during a call, like a phone call.
- **Amendment (2026-10-19):** Point 4 is replaced. During an active call, Android keeps the screen awake so it never times out and locks by itself. The proximity sensor turns the screen off at the ear and restores the call screen when moved away. The call screen shows over the lock screen while the call is active if the user locks the phone with the power button. Every call end path restores normal timeout, releases the proximity wake lock, and removes show-when-locked. iOS remains a no-op until the iOS milestone.
- **Ruled out:** `@supersami/rn-foreground-service` (needs a headless task and manual manifest edits, little maintenance, no End action); notifee (large, more than we need); `phoneCall` service type and ConnectionService / CallKit (these need telecom integration; that belongs with incoming calls); the `voip` background mode (no PushKit yet, and App Review expects VoIP pushes with it); `mediaPlayback` type (not needed alongside `microphone`, and each type adds a Play declaration).
- **Consequences:** Play Console needs a foreground-service declaration for `microphone`. If a call connects while the app is already in the background, Android 14+ refuses the service and that call can drop when the screen goes off. The small module is ours to maintain across Expo SDK upgrades.
- **Hardening (verifier findings):**
  - Each background start gets a generation; a deferred stop from an older call is skipped once a newer call has started the shared service. The wait for the start and the stop itself are bounded (`backgroundStopMs`), so hang-up always reaches ENDED.
  - A refused `startForeground` is reported to JS (`onStartRefused` → `background_start_failed`), and a start refused while backgrounded is retried when the app is active again.
  - The service calls `startForeground` before any other work and never stops before entering the foreground (avoids the "did not then call startForeground" crash). The module stops the service in `OnDestroy`, JS stops any orphaned service at startup, and the notification's End with no active call stops the service.
  - Mute reaches the transport only after media connected once, is re-applied after connect, is reset per call, and each change is bounded (`muteMs`) with the view rolled back on failure or timeout.
  - Audio-route work from a finished call (generation bumped by `reset()`) never selects an output or sets state; polling stops once the call is ending and pauses in the background.
- **Revisit when:** incoming calls arrive (ConnectionService/CallKit + `phoneCall` type + `voip`), or device testing shows OEM battery managers killing the service.

---

## ADR-020: Cartesia Sonic as an optional second TTS provider (evaluation)

**Status:** Accepted
**Date:** 2026-09-29

- **Context:** Twring has 12 months of Cartesia Scale credits. The owner chose to try Cartesia voices, in particular for Indian English, while Deepgram Flux TTS stays the launch voice. The TTS interface (`TtsProvider`/`TtsSession`, generation ids, "a cancelled generation is never heard") was built to allow a second provider without touching the pipeline.
- **Decision:**
  1. `apps/gateway/src/voice/cartesia-tts.ts` implements `TtsProvider` over Cartesia's TTS WebSocket: one socket per session, one Cartesia `context_id` per Twring generation, `continue:true` for streamed text, an empty `continue:false` input to flush, and `{context_id, cancel:true}` to cancel. Cartesia's cancel does not stop a context that is already generating, so chunks for any context other than the active one are dropped locally. Output is raw `pcm_s16le` at 48 kHz, the rate LiveKit publishes.
  2. Optional `CARTESIA_API_KEY` and `CARTESIA_TTS_MODEL` (default `sonic-3.6`). Without the key, `GET /v1/voices` does not list Cartesia voices, and an agent saved with one speaks in the default Deepgram voice (logged once).
  3. Cartesia voices have Twring ids `cartesia-<name>-en`, mapped to Cartesia voice UUIDs server-side in `agents/voices.ts`; `isAllowedVoice` remains the only gate. Labels carry no provider name.
  4. `agents/tts-router.ts` picks the provider by voice id for calls and voice samples. The pipeline and call controller are unchanged. Deepgram Flux STT is unchanged.
  5. **Deepgram stays the default voice** until `scripts/tts-latency-probe.ts` shows Cartesia's time to first audio and interrupt behaviour are at least as good on the staging network; any default change is a new decision.
- **Voices:** the Indian English voices (Janvi and Devansh, accent `en-IN/indian-english`) and the American/British voices (Skylar, Daniel, Archie) were checked against the live `GET /voices` library on 2026-09-29.
- **Ruled out:** a speech-to-speech model (CLAUDE.md rule: cascaded only); switching STT (no reason to); a per-call provider switch in the pipeline (routing by voice id is enough).
- **Rollback:** unset `CARTESIA_API_KEY`. Cartesia voices disappear from the picker and saved agents fall back to the default Deepgram voice; no data migration.
- **Revisit when:** the probe numbers are in, or the credits end.

---

## ADR-021: Google sign-in via Supabase Auth

**Status:** Accepted
**Date:** 2026-09-29
**Supersedes:** ADR-018 decision 1 (the single `dev-user`) outside development. ADR-018's file-backed store and credential encryption are unchanged.

- **Context:** Milestone 10 needs real accounts before testers outside the team: SECURITY §11–12 require a proven auth provider and per-user data. TECH_STACK and BACKEND_SPEC already name Supabase Auth.
- **Decision:**
  1. **Flow (native, no browser redirect):** the app runs Google Sign-In on the device (`@react-native-google-signin/google-signin`, configured with the Google **Web** OAuth client id as `webClientId`), takes the Google ID token, and calls `supabase.auth.signInWithIdToken({ provider: 'google', token })`. Supabase returns a session; `@supabase/supabase-js` keeps it in `expo-secure-store` (Keychain / Android Keystore, chunked under the store's ~2 KB value limit), refreshes it while the app is in the foreground, and never reads sessions from URLs (`detectSessionInUrl: false`).
  2. **Every `/v1` request** carries `Authorization: Bearer <Supabase access token>`. The gateway (`AUTH_MODE=supabase`, `SUPABASE_URL`) verifies it in an `onRequest` hook before the body is read: signature against the project's JWKS (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, cached 10 minutes, refetched for an unknown key id at most every 30 s so rotation works), `alg` ES256 or RS256 only (`none` and HS256 refused), issuer `${SUPABASE_URL}/auth/v1`, audience `authenticated`, `exp`/`nbf` with 30 s skew. The user id is `sub`. Failures: 401 `auth_required` (no token), 401 `auth_invalid` (bad token), 503 `auth_unavailable` (JWKS unreachable: fail closed). `/health/*` is not gated. Call tokens are minted only inside the gated `POST /v1/calls`, for the verified user.
  3. **App:** signed out, the only screens are Sign in (one action, "Continue with Google") and Privacy; the splash stays up until the stored session is read, so protected screens never flash. On 401 `auth_invalid` the API clients refresh the session and retry once (safe: the gateway rejects before any handler runs), then sign out with "Your session ended". Signing out ends a live call first.
  4. **Dev mode:** `AUTH_MODE=dev` (default and only allowed in `CORD_ENV=development`) keeps every request as `dev-user`. The app runs signed out of Supabase when its `EXPO_PUBLIC_SUPABASE_*`/`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` values are not all set (development only; config refuses that elsewhere). Staging and production refuse to start without `AUTH_MODE=supabase` and an https `SUPABASE_URL`.
  5. **Data from the dev-user era** stays under `user_id = dev-user` in `CORD_DATA_DIR`. It is **not migrated** to any signed-in account and no signed-in user can reach it. Delete it on staging with the data folder, or keep it for `AUTH_MODE=dev`.
- **Nonce:** Supabase's nonce check stays on. The free Google Sign-In API used here issues Android ID tokens without a nonce and Twring sends none, which Supabase accepts. The iOS Google SDK adds a nonce the app cannot read, so iOS needs *Skip nonce checks* or the library's paid Universal Sign-In; decided when iOS sign-in is tested.
- **Amendment 2026-10-20 (owner OK): Skip nonce checks is ON.** The first iPhone TestFlight sign-in failed with "Passed nonce and nonce in id_token should either both exist or not". The owner chose to turn on Supabase's *Skip nonce checks* (Google provider) so iOS testing could start. Supabase still verifies the Google signature, the audience (our client ids, now including the iOS client `605371988164-38pec6tfak…`) and expiry; what is lost is replay protection for a Google ID token within its one-hour life. Applies to Android too. **Before the App Store release:** move iOS sign-in to the browser OAuth flow (Supabase `signInWithOAuth` with PKCE, which also opens the way to Sign in with Apple, App Store guideline 4.8) and turn the nonce check back on.
- **Amendment 2026-10-20 (later; owner OK): the nonce check is back ON** (plan kept in the private notes).
  - On the iPhone, Google sign-in now runs in Apple's sign-in sheet: Supabase `signInWithOAuth` with PKCE, `expo-web-browser` `openAuthSessionAsync`, and the return address `<scheme>://auth/callback`. ID tokens from the iOS Google SDK are no longer used.
  - Sign in with Apple sits beside it (App Store guideline 4.8): native `expo-apple-authentication`, with a random nonce whose SHA-256 Apple signs and whose raw value Supabase checks.
  - Android keeps the native Google flow, whose tokens carry no nonce, which Supabase accepts.
  - The PKCE challenge is plain, not S256: React Native has no `crypto.subtle`, and adding one would make other code assume full Web Crypto. Apple's sheet returns the code straight to the app. `crypto.getRandomValues` comes from `expo-crypto`, because LiveKit's `registerGlobals` creates a `crypto` without it.
  - Deleting an account made with Apple first ends its Apple sign-in. The gateway's `POST /v1/me/apple-revoke` exchanges a fresh authorization code with the "Twring sign in" key and revokes the token.
  - Tested on iPhone (TestFlight build 8) and Android on 2026-10-20: Google and Apple both signed in after "Skip nonce checks" was turned off.
- **Known limit:** an access token stays valid until it expires (Supabase default 1 hour) even after sign-out elsewhere; the gateway does not call Supabase per request. Revocation is therefore bounded by the token lifetime (SECURITY §12, §21).
- **Ruled out:** the browser OAuth redirect flow (`signInWithOAuth` + deep link: more moving parts, worse UX); verifying with the legacy shared JWT secret (HS256 would put a signing secret on the gateway); calling Supabase `getUser` on every request (latency and a hard dependency per call).
- **Rollback:** `AUTH_MODE=dev` is refused outside development by design, so rolling back means reverting this change and redeploying (the app then stops sending tokens and the gateway treats everyone as `dev-user` again). Data written by signed-in users stays under their Supabase ids and would be unreachable until sign-in returns.
- **Revisit when:** data moves from files to Supabase Postgres with RLS (ADR-018 revisit), or Apple sign-in is needed for the App Store.

---

## ADR-022: Cartesia Janvi is the default voice; per-answer TTS errors

**Status:** Accepted
**Date:** 2026-09-30
**Supersedes:** ADR-020 decision 5 ("Deepgram stays the default voice").

- **Context:** ADR-020 kept Deepgram the default until the latency probe proved Cartesia at least as good on the staging network. The staging run (DEVELOPMENT.md, 2026-09-29, 5×5 sentences) measured first audio p50/p90 of 339/350 ms for Deepgram, 66/75 ms for Cartesia Janvi and 70/83 ms for Skylar, each with a clean cancel (0 bytes after cancel). Two Cartesia weak spots had to be fixed first: idle sockets are closed after 5 minutes, and a per-context error was treated as a broken session.
- **Decision:**
  1. **Default voice (owner decision 2026-09-30):** a new agent created without `voice_id` gets `cartesia-janvi-en` when `CARTESIA_API_KEY` is set, otherwise `flux-haley-en`. `GET /v1/voices` `default_voice_id` reports the same value; the app preselects it. **Existing agents keep their saved voice.** A saved voice no longer on the list still falls back to `flux-haley-en` at call time (Deepgram is always configured).
  2. **Idle keepalive:** Cartesia documents no application-level keepalive (https://docs.cartesia.ai/api-reference/tts/websocket), so the Cartesia session sends a WebSocket ping control frame (RFC 6455 §5.5.2) every 90 s while no generation is active. Pings carry no text and cost nothing. If an idle close still happens, the pipeline's existing reconnect reopens the socket.
  3. **Generation-scoped TTS errors (internal gateway interface, not a phone contract):** `TtsEvent` gains `generation_error` ("this answer failed, the session is fine"). Cartesia emits it for an error naming the active context (e.g. 429, 400). The pipeline fails only that answer through its existing per-answer path (`onSpeech … failed`, with the usual user-safe notice) and does not close the session or spend a reconnect attempt. Session-level errors (auth, socket close, protocol, an error naming no context) keep the `error` event and today's reconnect/fatal behaviour. Deepgram is unchanged.
- **Ruled out:** proactively reopening the socket before 5 minutes (costs a handshake and risks racing a reply; kept only as the fallback via reconnect); switching every existing agent to Janvi (changes a voice users chose).
- **Rollback:** unset `CARTESIA_API_KEY` (default returns to Haley, Cartesia agents fall back as in ADR-020), or revert this change.
- **Revisit when:** a larger staging sample or tester feedback contradicts the latency or quality result, or Cartesia documents a keepalive message.

---

## ADR-023: Local agent connector (outbound relay)

**Status:** Accepted
**Date:** 2026-09-30

- **Context:** Owner decision (2026-09-30): the beta must let any user connect the agent they already use (Claude Code, Codex, Gemini CLI, Hermes, and so on). Those agents run on the user's computer and have no public address; asking users for a tunnel or a public `wss://` endpoint excludes almost everyone.
- **Decision:**
  1. **`cord-connect`** (working name, one constant: `CONNECTOR_CLI_NAME`; package `apps/connector`) runs on the user's computer and dials **out** to the gateway. No inbound port.
  2. **Pairing:** the signed-in app calls `POST /v1/connectors/pairings` for a one-time code (`XXXX-XXXX`, alphabet without 0/O/1/I/L, 10 minutes, single use, in memory). The connector trades it at `POST /v1/connectors/claim` (the only unauthenticated `/v1` route; rate limited per IP) for a long-lived token (`cct_` + 256 random bits). The gateway stores only its SHA-256, bound to the user and connector id. `GET`/`DELETE /v1/connectors` list and revoke; `DELETE /v1/me/data` revokes too.
  3. **Relay:** `wss://<gateway>/v1/connectors/socket`, token in `Authorization` on the upgrade (checked before any frame). Protocol `cord-relay/1`: the connector's `connector.hello` names its agents; each call is a channel (`channel.open` / `channel.message` / `channel.close`) carrying unchanged `cord-agent/1` frames with the connector as the agent end. One socket per connector (a newer one replaces the older, close 4409); revocation closes with 4403; server pings every 20 s.
  4. **`cord-connector` saved agents** have `endpoint_url = cord-connector://<connector id>/<local agent id>`. The gateway drives a relay channel with the ordinary `NativeWsAdapter` (a `ws`-shaped channel socket), so handshake, heartbeat, stream guard, size limits, cancel, and "a turn is sent exactly once" apply unchanged. A channel is only opened on a connector owned by the calling user; otherwise, or when the computer is offline, the adapter fails with the new stable code **`agent_offline`** (also a call end reason and a phone error code, `AGENT_OFFLINE`).
  5. **Local adapters** (one module each, one interface): Claude Code (stream-json, read/search tools only by default), ACP (Gemini CLI, Hermes; permission requests denied unless the user allowlists a tool kind), Codex (`codex exec --json`, read-only sandbox), and any command (stdin/stdout). The connector relays text and the agent's own events; it never calls an agent's tools (rule 2).
- **Scaling:** the `connectorId → socket` map is in memory, which fits the single gateway process (BACKEND_SPEC §1). Several gateway processes would need either sticky routing of a user's calls to the process holding their connector, or a pub/sub hop (e.g. Redis) between processes; pairing codes would move to shared storage too.
- **Ruled out:** asking users to expose their agent (tunnels, port forwarding); the gateway calling a local HTTP server; a new agent protocol (the relay reuses `cord-agent/1`).
- **Rollback:** stop mounting `/v1/connectors` (remove `connectors` from `buildApp`); saved `cord-connector` agents then report `agent_offline`.
- **Revisit when:** more than one gateway process is needed, or real-agent testing shows a local adapter's interface has changed.

---

## ADR-024: Agent rings owner (invites, push, resume)

**Status:** Accepted
**Date:** 2026-10-01

- **Context:** Owner goal: "WhatsApp but with agents". A coding agent on the owner's computer needs them (permission, a question, a finished job) and should ring their phone; the owner answers and talks to the same agent session. References for the feel: Callhome's protocol (ring burst, a missed call leaves a voicemail, quick-decline with a reason the agent sees, DND, hang-up marker with a lingering window) and OpenLive's session resume.
- **Decision:**
  1. **Ring:** the connector (connector token, the same Bearer as its socket) calls `POST /v1/connectors/ring` with `{local_agent, reason (1–140, control/bidi characters stripped, never HTML-rendered), session_ref?}`. The gateway resolves the user's saved `cord-connector` agent for that connector and local agent (else 404 `agent_not_saved`) and refuses with 409 `owner_unavailable` (DND or quiet hours), `owner_busy` (in a call), `ring_pending` (one invite at a time per user), or `ring_rate_limited` (over 6 rings per agent per hour). Success is `201 {invite_id, expires_at}`; invite ids are `inv_` + 130 random bits.
  2. **Invites** ring for 30 s and live in a file collection (`ring-invites.json`), so a restart keeps them; on start, stale pending invites become missed. An unanswered invite becomes `missed`, writes a `missed_invite` call-history item with the reason (the phone shows "Missed call · agent: reason"), and sends `cord.ring_cancel`. The connector follows the outcome by long-poll (`GET /v1/connectors/ring/:id?wait=25`) and may cancel (`DELETE`).
  3. **The phone** registers push tokens (`PUT`/`DELETE /v1/me/devices/:deviceId`, at most 5 per user; a token re-registered by another user moves to them), sets `GET`/`PUT /v1/me/ring-settings` (`dnd`, `quiet_hours` with an IANA time zone), and reads, answers, or declines invites (`/v1/invites…`). Answer returns the same body as `POST /v1/calls` and goes through the same rules (one call at a time, daily allowance, computer online); exactly one answer wins (409 `invite_already_handled`), and an answer after expiry is 410 `invite_expired`. A decline stores a short note (`busy`, `outside`, `text`, or ≤ 60 characters) that the connector's long-poll returns.
  4. **The agent speaks first:** the answered call's first user turn is `[The owner answered your call. You rang because: <reason>. Tell them, then let them talk. <STAY_ON_CALL_RULE>]` (every agent learns the hang-up marker this way; Claude Code's voice system prompt and the connector's call preamble say it on every call). `STAY_ON_CALL_RULE` (contracts) lets an agent hang up only after the owner says goodbye or asks it to: delivering its news is not the end of the call (amended 2026-10-08, after Hermes hung up right after giving its result), and `channel.open` carries `resume_ref` so the connector resumes that session (Claude Code `--resume`, `codex exec resume`, ACP `session/load` when advertised). A resume that fails falls back to a new session; the reason line is still sent.
  5. **Push:** FCM HTTP v1, data-only, Android priority HIGH, TTL 30 s, authenticated with the service account in `FCM_SERVICE_ACCOUNT_FILE` (RS256 JWT exchanged at Google's token endpoint, cached until 5 minutes before expiry). Payloads are `cord.ring` and `cord.ring_cancel`, all string values. An `UNREGISTERED` or invalid-token answer deletes that device. Without push configured, rings still create invites (the phone sees them by GET) and the gateway logs `push_unconfigured`.
  6. **Hang-up marker:** agent text containing `⟪hangup⟫` (or `[[hangup]]`) is stripped from speech and display. After that reply has played to the end, the call ends as `agent_hangup` after a 6 s lingering window unless the owner starts speaking.
  7. **Connector CLI:** `cord-connect ring "<reason>" [--agent] [--session] [--wait]` (works without the daemon running), `ring --from-hook claude|codex`, and `hooks install|uninstall claude|codex` (Claude Code `Notification` hook; Codex `notify` only with `--on-turn-complete`).
- **Security:** one user's connector can only reach that user's saved agents and invites; the phone routes are owner-scoped (another user's invite is 404). Push tokens are personal data: never logged, removed with the device or with Delete my data.
- **Ruled out:** a VoIP/ConnectionService full-screen call in the gateway contract (the phone side decides presentation); S2S voice for the opening line (rule 1, the agent itself speaks first).
- **Rollback:** stop passing `ring` to `buildApp`; the connector's ring command then gets 404 and prints it.
- **Revisit when:** more than one gateway process is needed (timers and long-polls are in-process), or iOS needs APNs VoIP pushes.

---

## ADR-025: Computer-first linking

**Status:** Accepted
**Date:** 2026-10-01

### Context

Pairing a computer (ADR-023) started on the phone: it showed `npx cord-connect --code … --server …`,
which the user had to type on the computer. That is a long command with a server URL, the wrong way
round for a consumer ("WhatsApp Web" linking shows the code on the computer and the phone scans it).

### Decision

- `npx cord-connect` with no saved pairing and no `--code` asks the server for a link request
  (`POST /v1/connectors/link-requests`, unauthenticated, rate limited per IP, at most 5 open per IP
  and 1000 in all, 10-minute life) with its host name and detected agents. It gets an 8-character
  code and a secret poll token (32 bytes, stored hashed) and shows the code and a QR code holding
  `cord://link?code=…&server=…`.
- The computer long-polls `GET /v1/connectors/link-requests/:id` with its poll token. The connector
  token is handed out exactly once, on approval; otherwise it hears `expired` or `rejected`.
- The signed-in phone scans (expo-camera) or types the code, reads
  `GET /v1/link-requests/:code` to show "Link <computer>?" and its agents, then approves
  (`POST …/approve`, creating the connector like a claim) or cancels (`POST …/reject`). Wrong codes
  are rate limited per user and per address. Approving is idempotent for the user who approved,
  so a phone whose reply was lost can ask again. The phone then saves the chosen agents with the existing agents API.
- The phone refuses a QR code whose server is not its own API base URL; the code is the only thing
  it would send, but it never sends anything to a server it was not built for.
- The CLI's server defaults to `DEFAULT_SERVER` (`CORD_SERVER` overrides; staging for now).
- The phone-first flow stays as "Other ways to connect".
- After approval the computer prints which account it joined (`owner_name`: the display name, else
  the email masked as `g***@gmail.com`), so a computer linked into someone else's account by a
  photographed QR code is visible at once; `cord-connect --forget` undoes it.
- The approved answer is re-sent to the same poll token for 60 s, so a connection that drops as the
  token is delivered can poll again; other tokens still get 404.
- The computer cancels its own request on Ctrl+C or exit (`DELETE /v1/connectors/link-requests/:id`
  with the poll token). The phone then gets 410 `pairing_invalid` ("That code expired. Run
  cord-connect again."); expired or cancelled codes never count as wrong guesses.
- Per-address limits key IPv6 by /64 (IPv4 and IPv4-mapped by the full address).

### Alternatives

- Keep phone-first only: works, but the typed command is the hardest step of setup.
- Register the `cord://` scheme so the system camera opens the app: more surface (any app or web
  page could fire the link) for little gain over an in-app scanner.

### Consequences

- The app needs the camera permission, used only for scanning; the Android `CAMERA` permission is
  no longer blocked.
- Link requests live in gateway memory like pairing codes: a restart forgets them (the computer
  hears 404 and says to run the command again).

### Migration / rollback

Additive. Rolling back removes the routes; `--code` pairing keeps working.

### Revisit when

More than one gateway process runs (in-memory requests), or the brand domain replaces the staging
default server.

---

## ADR-027: Agents set themselves up

**Status:** Accepted
**Date:** 2026-10-06

### Context

Owner direction (2026-10-06): linking must have zero learning curve, as "one prompt with all
instructions in one shot; I forward it to my agent and it makes itself ready", with no technical
words on the consumer side. Many owners already chat with an agent that can run shell commands on
its own machine (Hermes on Telegram, OpenClaw, a coding agent on a VPS, home server, or laptop).
Scanning a QR code (ADR-025) needs a screen next to the phone, which a VPS does not have.

### Decision

- **"On my computer or server"** opens on **"Send a message to my agent"**. The phone creates a
  phone-first pairing code (`POST /v1/connectors/pairings`, ADR-023: single use, 10 minutes) and
  composes one message for the agent: download `<API base URL>/downloads/cord-connect.mjs` with
  `curl`, run `node cord-connect.mjs setup --code ABCD-EFGH`, and report the last line. The owner
  forwards it with Share or Copy; the phone counts down and waits for the claim, then shows the
  usual agent picker ("Choose your agents") with the machine's name. Scanning (ADR-025) and the
  code-entry wizard stay as secondary links. The command lives only inside the message.
- **The connector ships as one file**, `cord-connect.mjs`, bundled with esbuild
  (`pnpm --filter ./apps/connector bundle`, target node20) and served by Caddy from the Twring server.
  It checks for Node 20+ before anything else and says so in one line.
- **`cord-connect setup [--code]`** pairs (if not already linked), then installs itself as a
  background service running `<node> <this script>` in the current folder with the current PATH:
  a systemd system unit when root, else a systemd user unit (plus `loginctl enable-linger`), else
  a crontab `@reboot` line and a detached start; a LaunchAgent (KeepAlive, RunAtLoad) on macOS; a
  logon Scheduled Task on Windows that runs a hidden launcher which restarts the connector. It
  stops any copy already running for this config (pid file in the config folder), waits up to
  20 s for the running service to write `status.json` saying it is connected, and prints a line
  the agent relays: `Twring is ready. Your phone can call: Hermes. It keeps running in the
  background.` or the reason it failed. Running it again replaces what it installed.
  `cord-connect uninstall [--forget]` removes the service (and with `--forget` the link).
- No service file ever holds the token; the service runs the plain daemon, which reads the saved
  pairing (mode 600). As a service (`CORD_CONNECT_SERVICE=1`) it never prompts or shows a QR code.
- **Verification amendments (2026-10-06):** the message's command also passes
  `--server <API base URL>` (the file's own default is the staging server), and the phone makes
  no message from a server URL a shell could misread. The file is a plain-syntax prelude that
  checks the Node version and then compiles the bundled connector held in a string (so the check
  runs on Node 12 to 18 too). `setup` copies the file into the config folder and runs that copy.
  Without a usable pairing the service exits 78, which no service manager restarts (systemd
  `RestartPreventExitStatus=78`, launchd `KeepAlive` on the pairing file's `PathState`, the
  Windows launcher's loop). A pid is stopped only while its command line still runs the recorded
  script.
- **Re-link amendment (2026-10-06):** a machine that is already linked and gets a new `--code`
  claims it with its existing token (`POST /v1/connectors/claim` with
  `Authorization: Bearer cct_…`) instead of silently keeping the old link while the phone waits.
  The gateway accepts it only when the pairing's account owns that connector: it marks the
  pairing claimed by that connector (no new row, no new token), updates the connector's name and
  agents from the body, and answers 200 `{connector_id, reused: true}`. Another account's code
  gets 403 `pairing_other_account` (the code stays open), and setup prints
  `This machine is linked to another Twring account. Run: node cord-connect.mjs uninstall --forget,
  then send the message again.` and exits 2; an unknown or revoked token gets 401
  `connector_invalid`; a wrong, used, or expired code 400 `pairing_invalid`. Without a bearer the
  claim is unchanged. The phone's poll then reports that connector and moves to "Choose your
  agents"; agents of that computer already on the phone show checked and locked ("Already on your
  phone"), so none is added twice, and the button reads Continue when nothing is new. Setup's
  claim has a 20 s deadline; the systemd unit uses `WorkingDirectory=-<path>` so a removed folder
  does not stop the service at boot; on macOS without a GUI session (SSH) setup falls back from
  `launchctl bootstrap gui/<uid>` to `user/<uid>`.

### Security

- The code in the chat message is single use, valid 10 minutes, and links only into the sender's
  account. Anyone who reads the message within those 10 minutes could link **their** machine into
  the owner's account; the phone then shows that machine's name before any agent is added, so the
  owner sees it and can remove it. Chat apps' own storage of the message outlives the code, which
  is harmless once used or expired.
- The service runs as the user who ran setup; it is a root system unit only when setup itself ran
  as root (common on a VPS where the agent is root).
- The agent downloads code from the Twring server over https; the phone only ever builds the URL from
  its own API base URL.

### Alternatives

- A hosted installer script (`curl | sh`): harder to read for the agent, and a second artifact per
  OS. One Node file covers Linux, macOS, and Windows.
- npm (`npx cord-connect`): needs publishing and an npm on the machine; kept for later.

### Consequences

- The gateway host serves `/downloads/cord-connect.mjs` (Caddy); the bundle is rebuilt and copied
  there on each connector release.
- The app gains `expo-clipboard` for Copy; a build without it falls back to the share sheet.
- Only agents the connector knows (Claude Code, Codex, Gemini CLI, Hermes) or `--command` are
  offered; other chat agents need an adapter first.

### Migration / rollback

Additive. Rolling back the phone restores scanning as the first screen; installed services keep
working (they are the plain daemon) and `uninstall` removes them.

### Revisit when

The brand domain replaces the staging server, the connector is published to npm, or a chat agent
we want cannot run Node 20.

---

## ADR template

```md
## ADR-NNN: Title

**Status:** Proposed | Accepted | Superseded
**Date:** YYYY-MM-DD

### Context

### Decision

### Alternatives

### Consequences

### Migration / rollback

### Revisit when
```

## ADR-026: A working agent is not interrupted by more talk

**Status:** Accepted
**Date:** 2026-10-06

### Context

Every committed user turn superseded the turn in progress and cancelled its agent run. When the
agent had already reported tool events, the old text was not merged into the new turn (it may have
acted, so re-sending could replay an action), so the owner's earlier request was simply lost. On a
staging call to Hermes (ACP), the owner talked while Hermes worked: each cancelled prompt was
recorded by Hermes as "not processed", and the owner had to repeat themselves. Rule 5 already
separates audible stop from action cancellation; this decision makes the cancellation side
policy-aware for working agents.

### Decision

- **Agent working and has started a tool (`tool.start`):** a newly committed turn does not cancel
  it. The text is queued and sent as the next turn once the current turn is over (agent done and
  its answer played out or cut). Several queued utterances merge into one, capped at
  `MAX_MERGED_TURN_CHARS` (most recent text kept). The current answer still plays normally. Logged
  as `turn_queued` and `queued_turn_sent`.
- **Agent working, no tool started yet:** unchanged. The turn is superseded and its unheard text
  merged ("keep talking"), since nothing has been acted on.
- **Stop request:** a short utterance (at most 4 words) made only of stop words
  (`STOP_REQUEST_WORDS`: the STT interruption keyterms plus `cancel`, `never mind`, `nevermind`,
  `stop it`, `cancel that`), compared case- and punctuation-insensitively, cancels the running turn
  as before (speech cut, run aborted, `cancelTurn`) and drops the queue.
- **Agent speaking:** barge-in is unchanged; speech stops at once. If the agent is still running
  tools after its audio was cut, the committed text follows the queue-or-supersede rule above.
- A queued turn wins over a hang-up marker in the answer just heard: the queued turn is sent and the
  call does not hang up. If the working turn is already done when more talk is committed (its answer
  still playing), the queue and the new text are sent together, superseding the playout.
- The queue is dropped when the call ends (`queued_turn_dropped`).
- If the working turn ends while the owner is talking, the queue waits for them
  (`queued_turn_waiting`): their committed words are sent together with it, speech that turns out
  to be noise sends it alone, floor-control words that are a stop request drop it, and other
  floor-control words send it. Sending it under their words would start a prompt their commit
  cancels a moment later.
- A stop request is never merged ("keep talking") with the unanswered request it cancels; only the
  stop itself is sent.

### Alternatives

- Cancel and merge always: replays possibly non-idempotent actions. Rejected (security stance).
- Send the new text to the agent concurrently: most agents (ACP, Codex, Claude Code) accept one
  prompt per session at a time.

### Consequences

- An agent that asks a question mid-turn and keeps working gets the owner's answer only after its
  turn ends. Agents normally end their turn when they ask.
- The owner's way out of a long task is an explicit "stop" or "cancel".

## ADR-028: No dead air while the agent works

**Status:** Accepted (owner-approved)
**Date:** 2026-10-06

### Context

On a real Hermes call the agent's first word took p50 4–6 s, and 45 s and 132 s on tool-heavy
turns. Twring's own part (text to audio) is about 0.4 s. The owner heard silence and called the call
"very delayed". CLAUDE.md requires that long agent actions do not create dead air, with spoken
bridging only where product rules permit and never fabricated progress. VOICE_ARCHITECTURE §13
said Twring generates no filler; this decision makes a narrow, owner-approved exception.

### Decision

All of this is gateway-side (`conversation/presence.ts`, `ConversationController`), behind
`PRESENCE_CUES` (`on` by default, `off` disables the tone and the progress lines).

- **"Heard you" tone.** When a turn the owner just committed has no agent text 700 ms later
  (`PRESENCE_TONE_AFTER_MS`), the gateway plays one soft tone: two notes, 150 ms, peak -24 dBFS,
  generated in code (`PRESENCE_TONE`). Once per committed turn; never while the agent (or a Twring
  line) is speaking, never while the owner is speaking; not for queued turns or an answered ring's
  opening turn. It is queued on the outgoing audio like TTS, so a barge-in or the agent's first
  words drop it. It opens no speech generation, so it cannot start a barge-in or enter the echo
  window. Logged `presence_tone`.
- **Spoken progress lines.** (Timing amended by ADR-032's 2026-10-24 amendment: the generic line now waits 12 s.) While a turn works and the agent has produced no text for 4 s
  (`PROGRESS_LINE_AFTER_MS`, counted from the commit, its last text, or the end of its last audible
  speech), Twring speaks one line in the agent's voice through the normal TTS path:
  "Still working: <label>." when the open tool or activity has a label safe to speak (lowercase
  first letter, no tool-name shapes, digits, percentages, markup, or words like "almost"/"done"),
  else "Still working on it.". At most every 15 s (`PROGRESS_LINE_REPEAT_MS`), at most 4 per turn
  (`MAX_PROGRESS_LINES`); none in an opening turn's first 2 s (`OPENING_TURN_QUIET_MS`), none
  while anyone speaks (rechecked every `PROGRESS_LINE_RECHECK_MS`), none for a turn the owner
  silenced (barge-in or floor control), none once the agent is done (so none in the hang-up
  linger or a queued-turn handoff). The line is a speech generation like the agent's: echo
  matching covers it, and the owner talking over it stops it under the normal barge-in rules, but
  only the line: the turn keeps working (ADR-026) and its answer still plays. The agent's first
  text cuts the line and starts at once; the two never overlap. Lines are never sent to the agent,
  shown as agent text, or counted as turns or barge-ins. Logged `progress_line` with `label_kind`
  (`tool`, `activity`, `generic`).
  A turn speaks the generic line at most once and speaks a later specific line only when its safe spoken label differs from the last label spoken.
- **"Stop" always cuts a long wait.** A stop request now allows natural phrasing: up to 6 words
  (`MAX_STOP_REQUEST_WORDS`), at least one a stop word (ADR-026), the rest from
  `STOP_FILLER_WORDS` (please, no, ok, okay, just, hey) or the agent's display name ("Hermes,
  stop", "please stop", "no, cancel"; "stop the build after tests" is not one). It cancels the
  running turn whether or not a tool started, silences any line, drops the queue, and **is not
  sent to the agent**: Twring itself says "Okay, stopped." in the agent's voice. "Stop" is not work;
  handed to the agent as a new prompt it starts a new run that may re-plan or resume what it was
  told to stop. A stop request with nothing running is dropped (`stop_request_dropped`).

### Alternatives

- Agent-generated fillers only: most agents send nothing while a tool runs.
- Looping "thinking" audio: lies about activity and tires the ear.
- Sending "stop" to the agent (ADR-026 behaviour): the agent treats it as a new prompt.

### Consequences

- Twring now speaks a few fixed English lines of its own; they are limited to the strings above.
- A bare "wait" with nothing running no longer reaches the agent.
- TTS characters for the lines count in voice usage (they are real synthesis), not in agent turns.
## ADR-029: Approving agent actions on a call (2026-10-06)

- ACP agents can request one pending approval during a live turn; other adapters do not emit approvals in v0.01. The owner decides by a short yes/no voice response or an owner-scoped phone tap. The first decision wins.
- The gateway speaks only fixed phrases: change/delete/read files, run a command, open a web page, or do something that needs your OK. The agent's title and description are shown, never spoken. Unclear speech is not sent to the agent; Twring re-asks once.
- At 120 seconds without an answer, the gateway denies. Call end and turn cancellation also deny. The connected agent remains responsible for executing any approved action.

## ADR-030: A call continues the agent's conversation; work outlives the call (2026-10-08)

**Status:** Accepted (owner-approved: "fix it", after a real Hermes call)
**Date:** 2026-10-08

### Context

On a 4.5-minute call with Hermes (staging, 2026-10-08) the owner asked for a task to be done after
the call, then hung up while Hermes was working. The work stopped and no result arrived; on the
next call Hermes did not remember the request. The same agent in Telegram is fast and remembers.

The cause was the connector: every call created a new adapter, so a new `hermes acp` process and a
new session (cold start, empty memory), and the call's end closed the adapter, which cancelled
the running prompt and killed the process. Only an answered ring tried to resume a session.

Answering a ring also felt slow: the agent's opening words needed several seconds, so the owner's
"hello" talked over them.

### Decision

**The connector keeps one adapter per agent, across calls** (`pool.ts`):
- A call reuses the agent's live adapter: the same process and the same session, so the agent
  remembers earlier calls and starts warm.
- An idle adapter (no call, no running turn) closes after 30 minutes.
- The session reference is saved per agent (`sessions.json` beside the pairing, mode 600). A new
  adapter, after an idle close or a connector restart, resumes it where the agent supports that
  (ACP `session/load`), else starts a new session.

**Amendment (2026-10-19):** The owner can start a new conversation per connector agent. The
gateway persists that request and sends `fresh_session` on the next channel open. The connector
forgets the saved session and does not cut a running turn.
- Turns on one adapter run one at a time: a call's turn waits for a still-running background turn.

**Hanging up does not cancel the agent's work:**
- When a call ends (or the relay drops) during a turn the owner did not stop, the turn is detached.
  It keeps running for up to 30 minutes, pending approvals are denied (ADR-029: no approval
  without the owner), and its text is collected.
- When it finishes with text, the connector rings the owner (ADR-024). The reason is the reply's
  first sentence (sanitized, at most 140 characters), and the session reference is attached so
  answering continues the same conversation.
- No ring while a call to that agent is open (the agent already has the result in its session),
  for an empty reply, or for a turn that failed or was cancelled.
- An explicit "stop" or "cancel" from the owner still cancels at once (ADR-026).
- The call preamble tells the agent that if the call ends mid-task it should finish, and that its
  final reply reaches the owner as a call.

**An answered ring opens at once:** the gateway speaks the agent's own ring message in the agent's
voice as soon as the call is ready. The opening turn tells the agent that this was already said,
so it continues from there without repeating it.

### Consequences

- Calls and the agent's other conversations stay separate (Telegram is Hermes's own channel), but
  every Twring call to an agent is one continuing conversation.
- A warm agent process stays alive up to 30 minutes after a call (memory and CPU on the owner's
  machine).
- A background result can ring the owner up to ADR-024's ring limits; a missed ring shows on Home
  with Call back, so the result is never lost.
- The agent's own thinking time is unchanged. A warm, continuing session removes the per-call cold
  start, but a tool-heavy turn still takes as long as the agent takes.
- Amended 2026-10-13 (phone test): only work rings back. A call turn still running at hang-up is
  delivered only if it used a tool or ran 15 s or more after the call ended. A goodbye ("Okay,
  bye! ⟪hangup⟫") is talk; it is dropped, so it can't start a loop of ring-backs. Hang-up markers
  are removed before a result is saved as a chat message.

---

## ADR-031: Chats store conversation text (2026-10-13)

**Status:** Accepted (owner decisions, 2026-10-12; plan kept in the private notes)

### Context

Twring becomes a permanent channel per agent: you type to an agent, call it from the same chat, and its results land there. Until now the gateway stored no conversation text ("store less", SECURITY §23), and a background result reached the owner only as a ring; if the ring was refused or missed, only its first sentence survived.

### Decision

- One chat (thread) per user and saved agent. Typed messages and the agent's written replies are stored, sealed with AES-256-GCM under a key derived from the credential key, in `threads.db` (SQLite through `node:sqlite`) on the gateway host.
- Calls appear in the chat as a card only (length, outcome): no call transcript and no audio are stored (owner decision).
- Messages are kept until the owner clears the chat, deletes the agent, or deletes their data; at most 2,000 per agent.
- A typed message runs as one turn with `surface: 'text'` in the same agent session calls use (the connector pool, ADR-030). The gateway is the only entry for typed turns, at most one turn per agent; a turn that may have reached the agent is never resent (a restart marks it interrupted).
- Behind `THREADS_ENABLED` (default off) until the owner turns it on in production.

### Alternatives

- A Hermes-native channel first: two execution owners for one conversation. Rejected (plan §2).
- JSON collections: they rewrite the whole file on every change. Rejected for messages.
- Postgres now: a new service for a single-process gateway. Deferred until a second gateway process or server-side search.

### Consequences

- The privacy notice, the Data safety answers and SECURITY §9 now describe stored chats.
- Backups of `/var/lib/cord` hold sealed chat bodies; copy `threads.db` with SQLite's own backup, not a plain file copy, while the gateway runs.

### Migration / rollback

Additive. Turning `THREADS_ENABLED` off unmounts the routes and stops the service; `threads.db` stays on disk until deleted.

### Revisit when

A second gateway process is needed, or chats need server-side search.

## ADR-032: A short spoken acknowledgement while the agent is still silent (2026-10-23)

**Status:** Accepted (owner-approved: "Yes, add it")
**Date:** 2026-10-23

### Context

Production numbers for the 7 days to 2026-10-23 (222 turns): the agent's first text arrives p50 2.5 s
and p90 11.3 s after the owner's turn is committed; Twring turns that text into audio in p50 76 ms.
The wait people hear is the agent thinking, which Twring cannot shorten. ADR-028 already gives a soft
tone at 700 ms and a spoken "Still working" line at 4 s; between them the owner hears nothing they
recognise as an answer, and a call with a person never has that gap.

### Decision

- When an owner turn has no agent text 1.5 s after it was committed (`ACK_LINE_AFTER_MS`), Twring
  speaks one short line in the agent's voice: "Okay, one moment.", "Sure, let me see." or "Right,
  let me think." (`ACK_LINES`), taking turns through the call so two in a row never match.
- The lines acknowledge only; they never claim progress or describe the work. None is a
  stop-talking phrase ("one second", "hold on": ADR-017), so an echo of one cannot read as the
  owner asking to wait.
- Once per request: a turn that follows an acknowledged turn the owner has not heard answered
  (keep talking, merged or not) gets none. None for an answered ring's opening turn or a queued turn
  (ADR-026), none while an approval waits (ADR-029), none while anyone is speaking or another line
  plays. A moment missed is not made up later.
- It is a Twring line like ADR-028's: echo-matched, cut by a barge-in, never sent to the agent,
  shown as agent text or counted as a turn. The agent's first words cut it and start at once.
- Twring's lines (this one and ADR-028's) stay in the echo window for `ECHO_TAIL_MS` (1 s) after
  they end, not the 500 ms of a finished answer: a working turn is still open behind them.
- Twring's lines are timed from when they start, so `tts_first_audio` stays the agent's figure.
- It does not move the 4 s progress line, which still counts from the commit.
- Logged `ack_line` (with its `generation_id`); a cut line logs `presence_cue_cut` with
  `kind: 'ack'` and `played_ms`, so how often and how far in it is cut can be measured.
- `PRESENCE_ACK` (`on` by default) turns it off; `PRESENCE_CUES=off` turns it off too.

### Alternatives

- Do nothing: the measured gap is the agent's, and it is felt on most turns.
- Only the tone: ADR-028 has it; it reads as a sound, not as being heard.
- A filler model that writes a reply-specific opener: a second model speaking for the agent, against
  "voice is I/O, not intelligence".

### Consequences

- Twring speaks three more fixed English lines of its own; TTS characters for them count in voice
  usage.
- The line is about a second of audio, heard from about 1.6 s to 2.7 s. With the agent's first
  text at p50 2.5 s, roughly half of acknowledged turns hear it cut part way ("Okay, one mo-") before
  the answer. The owner asked for the cut; `played_ms` shows the real rate, and letting a nearly
  finished line end before the answer is the change to consider if it sounds abrupt.

### Migration / rollback

Set `PRESENCE_ACK=off` in `gateway.env` and restart the gateway.

### Revisit when

Agents' first text is usually under 1.5 s, or owners report the line as noise.

### Amendment (2026-10-24, owner-approved after the first day live)

The owner heard the lines as noise once agents answered faster (first text p50 2.9 s): "One
moment" was followed about 2 s later by "Still working on it", and 10 of 16 lines were cut part way.
Owner's rules: keep "One moment" / "Let me think" where it is; no "Still working on it" right after
it; keep "Still working: <what it is doing>" when the agent really works; "Still working on it" only
in a long silence.

- The generic line ("Still working on it.") now waits for 12 s of silence
  (`GENERIC_PROGRESS_LINE_AFTER_MS`); a line naming a real activity still comes at 4 s, and an
  activity that starts later is said when it starts.
- A Twring line (acknowledgement or progress) with at most 500 ms left (`CUE_FINISH_GRACE_MS`) now
  finishes before the agent's first words, which wait for it (at most 700 ms, then the line is cut
  as before). A line further from its end is still cut at once. Approval prompts and "Okay,
  stopped." are unchanged.
- "One moment" counts as speech the owner heard: a line about a real activity comes 4 s after it
  ends, and the generic line 12 s after it.
- `turn_committed` now logs `speech_ms` (from the start of speech to the commit) and `quiet_ms` (how
  long the words had stopped changing), and the runtime logs `caller_audio_stalled` /
  `caller_audio_resumed` when a caller's audio stops arriving for 5 s mid-call (not while muted or
  while the gateway reconnects).

## ADR-033: Open source for adoption, subscriptions for revenue (2026-10-27)

**Status:** Accepted (owner-approved: "yes add it to the ADR")
**Date:** 2026-10-27

### Context

People who run agents (Hermes, Claude Code, Codex) often already rent a VPS or a cloud sandbox, and
some already run their own speech models. They want Twring next to their agent, with their own
audio server and speech engines. The market pattern is to open-source for adoption with some
limits, while most users pay for the hosted service because self-hosting feels too complicated.
Two things tie a Twring install to us today: sign-in (our Supabase project) and rings on a locked
phone (Apple and Google deliver push only to our app, with our keys).

### Decision

- **License:** the server (gateway) is open source under **AGPL-3.0**: anyone can self-host it, and
  a hosted copy someone else sells must publish its changes. The phone app and the computer tool
  stay open too (license to choose before publishing; Apache-2.0 preferred). Adoption comes first.
- **Three ways to use Twring, one app:**

  | Who | Download | What they pay |
  | --- | --- | --- |
  | Subscription (hosted Twring) | Free | A monthly plan with included voice minutes, then per use |
  | BYOK (hosted Twring, their own speech keys) | Free | An unlock, plus a smaller monthly platform fee; their speech provider bills them |
  | Self-hosted (their own server, LiveKit, speech-to-text and voice) | Free | A yearly in-app charge for app upkeep and the ring service; free while we launch (amended 2026-10-29, ADR-034) |

- **The app is free to download for everyone.** App Store and Play charge one price per app, so the
  difference is an in-app purchase: "Use my own server / my own keys" unlocks self-hosted and BYOK
  modes. Without it the app connects only to Twring's servers. Subscriptions and unlocks are
  digital, so they go through Apple and Google billing (15% for small businesses and on Google
  subscriptions, 30% on Apple above US$1M a year); web payment links only where a store allows them.
- **BYOK keeps the full app:** calls, rings, chats, files, approvals. Only the speech bill moves.
- **Limits live in the cloud, never in the code.** Self-hosted chats and approvals, and calls on a
  server's own audio, work without Twring. The natural limit is the **ring relay**: rings and
  notifications to a locked phone go through a relay Twring runs, covered by the yearly in-app
  charge (amended 2026-10-29, ADR-034; free while we launch). Calls through Twring's audio service
  need the relay too. Cloud speech as a fallback for their own engines may be billed by use.
- **Self-hosting must feel simple** even if few use it: one `docker compose up` (gateway, LiveKit,
  optional Kokoro or Piper voice and Whisper or Parakeet speech-to-text), the app pairs with the
  server by scanning a QR code, and agents that already run speech models can be pointed to with one
  setting. Local engines ship with a one-command latency check, because small CPU-only servers will
  answer and stop more slowly than Deepgram.
- **An open app can be rebuilt without the unlock.** Accepted: people who rebuild it are the
  builders who spread Twring.

### Consequences

- Self-hosted Twring needs its own sign-in (an admin token or a one-time pairing code) instead of our
  Supabase project, and a server-address setting in the app.
- The ring relay becomes a product: per-install keys, the yearly charge, abuse limits.
  Amended 2026-10-29 (ADR-034): each install has a relay key with a `paid_until` date and a verified
  email address; the yearly charge extends `paid_until`. Before any charge starts, self-hosters are
  told in the app and by email, with the price.
- Speech providers stay swappable behind adapters (ADR-004, ADR-020); BYOK stores each person's speech keys encrypted
  like agent keys and never logs them.
- Billing arrives with the first paid tier: store subscriptions and the unlock, plus usage metering
  for minutes and rings.

### Order

1. BYOK on hosted Twring (smallest change, first revenue, proves the speech adapters).
2. The self-host kit: Docker Compose, own sign-in, QR pairing in the app, the ring relay.
3. Open the repository: scan the git history for secrets, write a real self-hosting guide, publish
   under AGPL-3.0.

### Still open

Subscription and unlock prices, the BYOK platform fee, and the self-hosted yearly price
(the app and computer tool license: Apache-2.0, ADR-035).

### Revisit when

Self-hosted installs grow without paid add-ons, or the stores change their rules on in-app unlocks
or web payment links.

## ADR-034: Self-host kit: one image, pairing mode, ring relay (2026-10-29)

**Status:** Accepted (rulings taken during the build on the owner's behalf; record in
`.superpowers/sdd/2026-10-29-self-host-kit-server/progress.md`)
**Date:** 2026-10-29

### Context

ADR-033 chose to let people run Twring on their own server. The kit has to install in one command,
work with the same app, keep calls and chats on that server, and still ring a locked phone, which
only Twring's app keys can do.

### Decision

- **One image, a self-hosted mode.** The gateway image runs hosted or self-hosted by config. The
  server address is `CORD_PUBLIC_URL` (https required in production); the installer's own inputs
  never reach the gateway config. The server's own Deepgram or xAI key drives speech; on an
  xAI-only server, people's own keys still win per side and only voices nobody can speak fall back
  to the server's xAI voice.
- **Sign-in by QR pairing.** No Supabase: a one-time pairing code (QR) makes a person and a device.
  People, devices and spaces with admin and member roles; a removed device gets `device_removed`
  (401), member-only refusals `forbidden` (403), and the last admin cannot be removed (`last_admin`,
  409), though they may delete their own data (the shell can mint a new admin). Removing a person
  revokes their connectors, rings and devices; `?purge=1` runs Delete my data for them. Admin
  commands use a separate local admin listener, reached through the `twring` command.
- **Shared agents, private sessions.** A server agent is shared per space. Each non-owner caller
  gets an opaque `session_scope` (HKDF of the credentials key and the person id); a computer that
  advertises `scoped_sessions` keeps one agent session per person, and an outdated computer link
  refuses members. Approval prompts during a member's turn are auto-denied: only the person whose
  computer runs the agent can approve its actions. The agent's own memory
  on its computer is shared and is disclosed to operators.
- **The yearly charge.** Self-hosting has a yearly in-app charge that pays for the ring relay and
  app upkeep; free while we launch, announced in the app and by email with the price before it
  starts. It extends the install's `paid_until`. Without it (or without a confirmed email after 7
  days) rings pause, and so do calls through Twring's audio service; chats and calls on a server's
  own audio keep working while the app is open.
- **Ring relay.** Rings and notifications for every self-hosted server go through a relay Twring
  runs (`relay.twring.com`). Each install registers with a server key, gets a relay key (stored
  hashed) and must verify an email; a 7-day grace covers the unverified start. Calls to the relay
  carry single-use signed proofs; phones get device tickets; relay handles are bound to one
  install and one device (duplicates refused). Notification contents are sealed on the server for
  the receiving device and the relay cannot read them. Sends that can never succeed return the
  outcome `unsupported` and are not retried; limits are per install, per handle and per push token,
  in the hosted token formats, with ring TTL capped at 60 s. Ring service state `unknown` is shown
  before the relay has answered. The relay uses its own Resend key and versioned SQLite migrations.
- **Audio.** A server with its media ports open runs its own LiveKit. Otherwise (most sandboxes)
  calls use Twring's LiveKit through the relay: short tokens, distinct refusal codes (paused,
  expired, limit) mapped to plain app copy, and minutes settled by LiveKit webhooks
  (`room_finished`), never by the server's word.
- **Deletion and retention.** `DELETE /v1/installs/self` (relay key) deletes an install with its
  phones, usage and audio records; `twring uninstall` calls it first (best effort, then points to
  support). Per-call audio records are pruned 90 days after the call ends.
- **Reachability probe.** The relay checks only the install's registered address (from its own
  `GET /v1/ip` or the domain given), HTTPS only on port 443, with a per-IP cap and fixed-time
  failure replies, so it cannot be used to scan other hosts.
- **Installer.** `curl -fsSL https://twring.com/install.sh | sh`: never installs Docker or pipes
  another script, uses digest-pinned images and a checksummed kit (`selfhost/versions.json`),
  keeps secrets out of command lines (use `sudo -E` with exported settings), writes keys into the
  data volume owned by uid 10001, links agents as the invoking user (never root silently), and
  leaves `TRUST_PROXY` unset in sandboxes unless `TWRING_TRUSTED_PROXIES` is given.

### Consequences

- Contracts gained `device_removed`, `forbidden`, `last_admin`, push outcome `unsupported` and ring
  service state `unknown`; paired-device routes live under `/v1/me/paired-devices/...`, and the
  hosted push-token routes answer 404 in self-hosted mode.
- Rotating `CORD_CREDENTIALS_KEY` starts members on new agent sessions.
- `/v1/server` `ring_service` gains state `unregistered` (no `paid_until`) when the relay answers
  401: the registration was deleted (often `twring uninstall` on a machine the server moved from).
  The gateway logs a warning at most hourly; `twring register` registers the same server key again.
  The relay keeps only a SHA-256 of each address in `email_sends` (pruned after a day, and with the
  install on deletion).
- Twring operates the relay and its LiveKit webhooks; a missing webhook logs
  `audio_webhooks_missing`.
- The app side (pairing, "Use my own server", the yearly charge) is Plan B, coming with the app
  update; the kit is announced when it ships.

### Revisit when

The relay needs a second region, or self-hosters ask for HTTPS on a port other than 443.

## ADR-035: Open-source layout (2026-11-03)

**Status:** Accepted (owner decisions, 2026-11-03)

### Decision

- The public repository `saasagelabs/twring` starts from a fresh history; the earlier history stays private as `saasagelabs/twring-history`.
- Licenses by folder: the server (`apps/gateway`), the ring relay (`apps/relay`), the self-host kit (`deploy/selfhost`) and `supabase/` are AGPL-3.0-only; the phone app, the computer tool, shared packages, the skill, examples, the site, docs and tooling are Apache-2.0; the site's fonts are OFL-1.1. `LICENSE.md` maps folders to licenses.
- Contributions are signed off under the Developer Certificate of Origin; there is no contributor license agreement.
- Internal planning notes and the operations scripts and docs for Twring's own servers stay private.
- The Twring name, logo and icons are not licensed with the code (`TRADEMARKS.md`).
- Development happens in the public repository; the private notes live beside it in a git-ignored `private/` checkout.

### Consequences

- Contributions merged under DCO stay under their folder's license; a contributor agreement, if ever wanted, applies only to later contributions.
- Public CI runs on free GitHub Actions minutes.
