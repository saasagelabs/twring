# CLAUDE.md: Claude Code project briefing for Twring

Never use em dashes (U+2014) in any text: use a colon, comma, parentheses or a new sentence. `pnpm lint` fails on them.

## What we are building

Twring is a mobile voice layer for existing AI agents.

**Positioning:** `Bring any agent brain. Get the voice.`

A user connects an agent that already works in text/chat, chooses a voice, presses Call, and talks to the same agent in a continuous low-latency internet call. The connected agent keeps its own reasoning, model, memory, tools, MCP servers, permissions, and action behavior. Twring supplies media transport, speech recognition/synthesis, turn-taking, interruptions, call UI, adapter normalization, and reliability.

## Product constraints

- Android launches first; iOS compatibility begins on day one, so never defer cross-platform architecture.
- The app runs as Expo development builds, never in Expo Go.
- Deepgram Flux STT and Deepgram streaming TTS are the first voice providers.
- Cascaded STT → existing agent → TTS; **no speech-to-speech model gets control of agent actions.**
- V1 is intentionally narrow. No agent builder, workflow builder, PSTN calling, marketplace, or agent-to-agent network.
- The experience must feel like a call, not voice-note exchange.
- Ship a complete simple product before generalized abstractions. No Nx/Turborepo unless measured build pain justifies it.

## Docs

The design docs live in `docs/`, and its README indexes them (product, architecture, decisions, voice, adapters, security, UX, design system, SLOs, release). Before architecture work, read the ones the task touches; for scoped work read only what is relevant, and search before loading large unrelated files.

## Rules that must survive refactors

1. **Voice is I/O, not intelligence.**
2. **Twring does not call the connected agent's tools.** The agent calls its own tools.
3. **No provider secret in the mobile binary.**
4. **Streaming is the default path.** Partial STT may drive UI/preflight; confirmed user turns drive committed agent work; text deltas feed TTS incrementally.
5. **Interruption is a first-class state transition.** Audible speech must stop quickly; action cancellation is separate and policy-aware.
6. **All external events become Twring-normalized contracts before reaching product UI.**
7. **Reconnect is resumable and idempotent where possible.**
8. **Android-specific functionality is hidden behind platform interfaces.**
9. **Production simplicity beats speculative scale.**
10. **A change to these rules requires a recorded decision (an ADR in the decisions log).**

Two more that are cheap to keep and costly to miss:

- **The connector is not on npm.** Never write `npx twring-connect` or `npx cord-connect` anywhere (the `twring-connector-distribution` skill has the real install command).
- **Outside contributors:** nothing is posted on GitHub for them (comment, review, label, close, merge) until the owner approves that reply (the `twring-outside-contributions` skill).

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

Use the budgets in the observability and SLO doc.

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

Read the UX spec and the design system doc before presentation-critical work.

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

Read the security and privacy doc before auth, credential, networking, or logging work.

## Working with other agents

Never have two agents edit the same files at once: give each its own branch or worktree. When delegating or using subagents, the parent stays responsible for integration, and subagents do not change architecture contracts unless that change is the explicit task. Task ownership and which agent leads what are in the orchestration doc (see the `docs/` index).

## Lessons from production (keep this list current)

- **A change is not done until users can get it.** A gateway change needs a deploy, a connector change a published bundle, an app change new Android and iOS builds. If a release step is left, say which one. The `twring-release` skill has the steps and the traps.
- **Check where the user looks:** the live download, the installed build on a real device, the rendered page or video as a viewer sees it. Passing tests are necessary, not sufficient.
- **Windows checkouts:** some tools write CRLF line endings; run `pnpm format:check` before committing. Keep worktrees on short paths (native Android builds fail on deep ones).

Rarer traps live in project skills that load when a task needs them: releases and server operations, how the connector reaches people, outside contributions, the patched dependencies, and accounts and rings. When you learn a new lesson, add it to the skill it belongs to, or here if it applies to almost every task.

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
- the change is released where users get it, or the remaining release step is stated.
- Commits carry a DCO sign-off (`git commit -s`).

If a task reveals a genuinely new product decision, implement the safe/minimal behavior and surface the decision clearly rather than inventing a broad new product direction.
