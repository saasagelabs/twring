# Twring Product Specification

**Codename:** Twring  
**Positioning:** **Bring any agent brain. Get the voice.**  
**Launch target:** Android first; iOS-compatible from the first commit.  
**Category:** Internet-native voice interface for existing AI agents.

## 1. Product thesis

AI agents are becoming genuinely useful in chat because they can remember context, call tools, browse, code, operate APIs, and perform real work. The remaining bottleneck is interaction: users still have to open a chat surface, type, wait, read, and type again.

Twring removes that interaction bottleneck without replacing the agent.

The user connects an agent they already trust. Twring gives that agent a natural, low-latency internet call experience. The same agent keeps the same memory, tools, permissions, policies, and actions it already has in chat.

The first-use reaction we are designing for is:

> **“Oh. I can just call my agent now.”**

Twring wins when the experience feels like calling a capable collaborator rather than exchanging voice notes.

## 2. Product promise

A first-time user should be able to:

1. Install Twring.
2. Sign in.
3. Tap **Connect Agent**.
4. Choose the simplest adapter supported by their agent.
5. Enter the minimum required connection information.
6. Run a connection test.
7. Choose a voice.
8. Tap **Call**.
9. Speak naturally.
10. Interrupt naturally.
11. Hear the agent start responding quickly.
12. See truthful activity when the agent is using tools or working.
13. End the call and keep a concise call record.

The connected agent must behave as much as possible like it does in text chat.

## 3. The user problem

Existing agent experiences create friction:

- typing is slow when the user is walking, driving, cooking, debugging, or multitasking;
- chat makes long-running agent work feel detached;
- voice-note-style systems force strict alternating turns;
- many realtime voice products replace the user's agent with a separate realtime model, changing reasoning and tool behavior;
- voice integrations often require technical rebuilding of the agent;
- mobile call experiences are hard to engineer reliably from scratch.

Twring addresses these problems by separating **voice mechanics** from **agent intelligence**.

## 4. Product principles

### P1: The agent remains the agent

Twring never silently substitutes another model for the user's connected agent.

If the connected agent uses a particular model, tool stack, memory system, MCP servers, or custom backend, Twring does not reimplement those responsibilities.

### P2: Voice is I/O, not authority

STT hears. TTS speaks. LiveKit transports media. Twring orchestrates the session.

None of those components get autonomous access to the user's connected-agent tools.

### P3: It must feel like a call

The experience must not be:

`record → upload → wait → receive audio → record again`

It should be:

`listen continuously → detect a real turn → send immediately → stream the agent → speak incrementally → allow barge-in`

### P4: Truthful activity beats fake animation

If the agent is using a tool, Twring may show “Checking calendar…” only when the adapter actually supplied that activity.

Twring must never invent tool progress just to make the UI feel busy.

### P5: Zero-learning-curve connection

Developers may understand WebSockets, SSE, AG-UI, and A2A. Ordinary users should not need to.

Connection setup should explain only what is required for that adapter.

### P6: Fast shipping with production sanity

“Fast” does not mean fragile. V1 still needs authentication, safe credential handling, reconnect behavior, cancellation, real-device testing, logs/crash reporting, understandable errors, Android store readiness, and iOS smoke testing.

It does not need speculative distributed infrastructure.

## 5. V1 target users

Primary early users:

- developers who already have an agent endpoint;
- founders/operators using custom business agents;
- people using coding or workflow agents with actionable backends;
- AI builders who want mobile voice access without rebuilding their agent as a voice agent.

Secondary early users:

- teams exposing an internal agent endpoint;
- agent frameworks that want an optional “Call this agent” surface;
- advanced users running local/self-hosted agents reachable through a secure endpoint.

V1 is **not** designed around non-technical users creating an agent from scratch.

## 6. Core V1 jobs

### Job A: Connect an agent

Create a saved agent profile with:

- display name;
- optional avatar;
- adapter type;
- endpoint/configuration;
- credential reference;
- selected voice;
- optional safe metadata.

### Job B: Test the connection

Before the first call, Twring verifies:

- endpoint reachable;
- authentication accepted;
- protocol response valid;
- streaming works where expected;
- minimal health message succeeds;
- adapter reports missing capabilities.

### Job C: Call the agent

Twring creates a call session, obtains short-lived LiveKit credentials, connects mobile and gateway, opens STT/TTS, connects the agent adapter, and enters listening state.

### Job D: Converse naturally

Twring supports:

- low-latency streaming STT;
- turn detection;
- streaming text from the agent;
- streaming TTS;
- interruption/barge-in;
- speaking/listening indicators;
- agent-working states;
- graceful retry/reconnect.

### Job E: Observe agent activity

If the adapter emits meaningful events, Twring maps tool/activity/approval/error/done states into a small normalized call UI.

Twring does not require every agent to expose tools.

### Job F: End and revisit

When the user ends the call, media stops, providers/adapters close cleanly, safe call metadata persists, transcript persistence follows privacy settings, and the user sees a compact call-ended screen.

## 7. Required V1 product surfaces

- splash/startup;
- sign in/account;
- first-run onboarding;
- saved agent list;
- connect agent;
- adapter configuration;
- connection test;
- voice selection;
- agent detail;
- outgoing call;
- active call;
- reconnect/error states;
- call-ended screen;
- call history;
- settings;
- privacy/data controls;
- hidden/advanced developer diagnostics.

## 8. Explicit V1 exclusions

Do not build unless scope changes:

- agent creation;
- prompt studio;
- model selector for the connected agent;
- MCP management UI;
- workflow builder;
- agent marketplace;
- public agent discovery;
- agent-to-agent calling;
- PSTN/SIM/SIP calling;
- video/group rooms;
- arbitrary screen sharing;
- enterprise SSO;
- Kafka/Kubernetes;
- active-active multi-region;
- custom billing engine.

## 9. Product definition of realtime

Twring does not promise zero latency. It promises continuous, incremental behavior.

A conversation feels realtime when:

- microphone capture is continuous;
- end-of-turn is detected quickly;
- the agent request starts immediately after turn commit;
- agent text is consumed as a stream;
- TTS starts from safe chunks instead of waiting for the full answer;
- audio playback starts as soon as TTS audio arrives;
- users can interrupt;
- UI reflects real call state continuously.

Numeric budgets live in `OBSERVABILITY_AND_SLOS.md`.

## 10. Interruption semantics

User interruption must:

1. detect user speech during agent playback;
2. stop audible TTS quickly;
3. invalidate queued speech for the old response;
4. begin a new user turn;
5. decide separately whether underlying agent generation can/should be cancelled.

Stopping speech and stopping an action are not the same thing.

Twring never assumes that stopping TTS reverses a tool call owned by the connected agent.

## 11. Two-way calling direction

The product direction includes both:

- **human → agent:** user opens Twring and calls;
- **agent → human:** an authorized external trigger causes an incoming internet call.

V1 may ship human → agent first. Architecture must not block incoming calls.

Incoming calls eventually require explicit user enablement, reason/source identity, rate limits, quiet hours, push, answer/decline, and no microphone publication before answer.

Still no PSTN requirement.

## 12. Success metrics

Core:

- connection success rate;
- call start success rate;
- tap-to-connected latency;
- speech-end to first audible agent response;
- interruption stop latency;
- reconnect success rate;
- call failure rate;
- successful first-call rate after agent setup;
- repeat call rate;
- crash-free sessions.

Qualitative:

- “felt like a call”;
- “same agent behavior as chat”;
- setup clarity;
- abandonment during adapter setup;
- whether users choose Twring instead of opening the original chat surface for appropriate tasks.

## 13. Launch acceptance

Android V1 is launchable when:

- new user can install/sign in;
- supported agent can be connected without external Twring documentation;
- connection test catches invalid config;
- call starts reliably on representative Android devices;
- STT → agent → TTS works with streaming;
- interruption and hang-up work;
- reconnect handles short network transitions;
- Bluetooth/wired/speaker routes are tested;
- credentials are not bundled in app;
- crash reporting/backend logs are live;
- errors are understandable;
- privacy controls exist;
- iOS app compiles and core call path is smoke-tested even if iOS is not submitted yet.

## 14. Product language

Preferred:

- Bring any agent brain. Get the voice.
- Call your agent.
- Connect your agent.
- Your agent stays in control.
- Internet call.
- Voice layer for agents.

Avoid wording that implies Twring itself is the agent brain.

## 15. North star

Twring is successful when someone with a useful text agent can add voice with minimal integration work, open the app, press Call, and experience the same capable agent as a natural internet conversation.

Protect that from scope drift.
