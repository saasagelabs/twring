# CLAUDE.md: Claude Code project briefing for Twring

## What we are building

Twring is a mobile voice layer for existing AI agents.

**Positioning:** `Bring any agent brain. Get the voice.`

A user connects an agent that already works in text/chat, chooses a voice, presses Call, and talks to the same agent in a continuous low-latency internet call. The connected agent keeps its own reasoning, model, memory, tools, MCP servers, permissions, and action behavior. Twring supplies media transport, speech recognition/synthesis, turn-taking, interruptions, call UI, adapter normalization, and reliability.

## Product constraints

- Android launches first.
- iOS compatibility begins on day one; do not defer cross-platform architecture.
- React Native + Expo development builds + TypeScript.
- LiveKit is the realtime media/session foundation.
- Deepgram Flux STT + Deepgram streaming TTS are the first voice providers.
- Cascaded STT → existing agent → TTS; **no S2S model gets control of agent actions.**
- V1 is intentionally narrow. No agent builder, workflow builder, PSTN calling, marketplace, or agent-to-agent network.
- The experience must feel like a call, not voice-note exchange.
- Ship a complete simple product before generalized abstractions.

## Read these before architecture work

- `docs/PRODUCT.md`
- `docs/ARCHITECTURE.md`
- `docs/TECH_STACK.md`
- `docs/VOICE_ARCHITECTURE.md`
- `docs/AGENT_ADAPTER_SPEC.md`

For scoped work, read only the relevant docs. Use search/grep before loading large unrelated files.

## Rules that must survive refactors

Never use em dashes (U+2014) in any text: use a colon, comma, parentheses or a new sentence. `pnpm lint` fails on them.

1. **Voice is I/O, not intelligence.**
2. **Twring does not call the connected agent's tools.** The agent calls its own tools.
3. **No provider secret in the mobile binary.**
4. **Streaming is the default path.** Partial STT may drive UI/preflight; confirmed user turns drive committed agent work; text deltas feed TTS incrementally.
5. **Interruption is a first-class state transition.** Audible speech must stop quickly; action cancellation is separate and policy-aware.
6. **All external events become Twring-normalized contracts before reaching product UI.**
7. **Reconnect is resumable and idempotent where possible.**
8. **Android-specific functionality is hidden behind platform interfaces.**
9. **Production simplicity beats speculative scale.**
10. **A change to these rules requires a recorded decision in `docs/DECISIONS.md`.**

## Expected repository shape

```text
apps/mobile       Expo React Native application
apps/gateway      Node/TS LiveKit voice gateway + HTTP APIs
packages/contracts
packages/agent-adapter
packages/config
packages/test-fixtures
docs/
```

Use pnpm workspaces. Do not add Nx/Turborepo unless measured build pain justifies it.

## How to approach implementation

For meaningful changes, use this loop:

1. **Inspect**: relevant docs, existing implementation, tests, and public interfaces.
2. **Plan**: identify the smallest vertical slice that satisfies the task.
3. **Implement**: keep provider-specific logic at edges.
4. **Exercise failure paths**: timeout, cancellation, reconnect, malformed events, permission denial.
5. **Verify**: typecheck, lint, tests, and the appropriate mobile/gateway smoke test.
6. **Self-review**: compare the diff to acceptance criteria and architecture invariants.
7. **Document**: update contract/decision docs only when the external behavior or architecture changed.

Avoid making broad refactors inside feature tasks unless the existing structure blocks a correct implementation.

## TypeScript expectations

- strict mode on;
- no ambient `any` spreading through the codebase;
- Zod or equivalent runtime validation at network/persistence boundaries;
- discriminated unions for call and adapter events;
- exhaustive switching for state-machine events;
- errors carry stable machine codes plus human-safe context;
- cancellation uses `AbortSignal` or a similarly consistent primitive;
- timers live behind testable abstractions when state-machine behavior depends on them.

## Voice quality expectations

Do not optimize only “model latency.” Measure the whole perceived path:

- speech end → committed turn;
- committed turn → first agent event;
- first text delta → first TTS audio;
- first TTS audio → playout;
- user speech during agent playout → audible stop;
- reconnect start → media restored.

Use the budgets in `docs/OBSERVABILITY_AND_SLOS.md`.

Long agent actions must not create dead air. If the connected agent provides activity/tool events, translate them into concise UI state and optional short spoken bridging only when product rules permit. Never fabricate progress.

## UI/UX expectations

Twring is consumer-simple even if the internals are technical.

- one primary action per screen;
- connection setup explains endpoints/credentials with examples, not protocol lectures;
- active call remains visually calm;
- waveform/status reflect real state, not decorative looping that lies about activity;
- haptics reinforce connection, answer, hang-up, and errors;
- reduced motion, dynamic text, screen readers, and adequate hit targets are mandatory;
- errors say what happened and what the user can do next.

Read `docs/UX_UI_SPEC.md` and `docs/DESIGN_SYSTEM.md` before implementing presentation-critical work.

## Security stance

Treat connected agents as external systems, even if user-owned.

- validate event streams;
- enforce HTTPS/WSS in production;
- do not trust agent-provided HTML/markdown for native rendering without sanitization;
- redact secrets from logs;
- store user adapter credentials encrypted/server-side where possible;
- use short-lived LiveKit access tokens;
- constrain callback URLs and prevent SSRF in any server-side endpoint connection logic;
- apply rate and size limits to streaming payloads;
- never replay a non-idempotent action due to network retry.

Read `docs/SECURITY_AND_PRIVACY.md` before auth, credential, networking, or logging work.

## Multi-agent coding coordination

Claude Code is generally the lead for architecture-heavy vertical slices, cross-package refactors, and complex debugging. Codex can independently implement scoped tasks, tests, reviews, and parallel backlog items. These are workflow defaults, not capability claims.

Do not have both agents edit the same files simultaneously. Use branches/worktrees and task ownership from `docs/ORCHESTRATION.md`.

When delegating/subagenting, keep the parent responsible for integration. Do not allow subagents to independently change architecture contracts unless that change is the explicit task.

## Completion checklist

Before saying a task is complete:

- acceptance criteria satisfied;
- relevant tests written and passing;
- `pnpm` type/lint checks for touched workspace pass;
- failure and cancellation paths considered;
- no secret or temporary log committed;
- Android validated for runtime changes;
- iOS compatibility considered and smoke-tested when feasible;
- no architectural invariant silently changed;
- user-facing behavior remains simple.
- Commits carry a DCO sign-off (`git commit -s`).

If a task reveals a genuinely new product decision, implement the safe/minimal behavior and surface the decision clearly rather than inventing a broad new product direction.
