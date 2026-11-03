# AGENTS.md: Codex operating instructions for Twring

This file is the repository-level operating contract for Codex. Read it before modifying code. The product and architecture source of truth lives in `docs/`; this file tells you **how to work** inside that truth.

## Mission

Build **Twring: “Bring any agent brain. Get the voice.”** Twring makes an existing agent callable over the internet. Twring owns voice transport and conversation mechanics; the connected agent remains responsible for reasoning, memory, tools, permissions, and actions.

Do not redesign Twring into a generic assistant, agent builder, phone/PSTN product, or speech-to-speech wrapper.

## Mandatory reading order

Before a substantial feature, read only the documents relevant to the task, beginning with:

1. `docs/PRODUCT.md`
2. `docs/ARCHITECTURE.md`
3. task-specific docs named by the task

Avoid loading every document into context unnecessarily. Retrieve just-in-time.

## Architecture invariants

Never casually violate these. If a task truly requires a change, stop implementation and propose an ADR entry in `docs/DECISIONS.md`.

- Twring does not become the agent brain.
- STT/TTS providers do not receive tool authority.
- Actions remain owned by the connected agent.
- Call audio and agent event paths must stream.
- Android-first code remains iOS-ready.
- Provider code stays behind interfaces.
- Reconnects must not duplicate user actions.
- Interruption cancels playback promptly; it does not automatically imply destructive cancellation of already-started agent actions.
- No speculative microservices, queues, caches, brokers, Kubernetes, or event-sourcing infrastructure.

## Preferred implementation shape

Use the existing repo conventions once they exist. Initial target:

- TypeScript everywhere practical.
- React Native + Expo development builds in `apps/mobile`.
- Expo Router for navigation.
- Node.js TypeScript gateway in `apps/gateway`.
- LiveKit for WebRTC/media/session transport.
- Deepgram Flux STT and streaming TTS behind provider interfaces.
- `packages/contracts` for schemas and event types shared by app/gateway/adapters.
- `packages/agent-adapter` for the normalized adapter contract and implementations.
- Supabase for authentication and persisted product metadata unless an ADR changes this.
- Zod at external and persistence boundaries.
- pnpm workspaces; no additional monorepo runner until justified.

## Coding rules

- Prefer boring, legible code over clever abstraction.
- Keep functions small enough that failure behavior is obvious.
- Every external I/O boundary must have typed errors, timeout behavior, and cancellation semantics where relevant.
- Never put provider API keys or LiveKit server secrets in the mobile bundle.
- Never log raw secrets, auth headers, full access tokens, or unredacted sensitive payloads.
- Avoid `any`; if unavoidable at a third-party boundary, narrow immediately.
- Validate inbound webhook/API/adapter payloads with shared schemas.
- Make retries explicit and bounded. Do not retry non-idempotent agent actions blindly.
- Use `AbortSignal`/cancellation consistently for active turns and network requests.
- Treat sequence/order IDs as first-class on streaming events.
- Do not add a dependency if a few clear lines of code are safer and easier to maintain.
- Do not replace approved dependencies for taste alone.

## Voice-specific rules

A voice feature is incomplete unless it considers:

- end-of-turn detection;
- first-response latency;
- barge-in/interruption;
- false interruption recovery;
- TTS chunking;
- audio-route changes;
- Bluetooth/headset behavior when applicable;
- foreground/background transitions;
- network loss/reconnect;
- duplicate event prevention;
- user-visible status during long agent tool work.

Do not implement a record/upload/wait/playback loop. Twring must feel like a call, not exchanged voice notes.

## Agent adapter rules

The adapter is a transport normalization layer, not an intelligence layer.

Required conceptual operations:

- connect/health check;
- begin or resume session;
- send user turn;
- receive streamed normalized events;
- cancel a turn when supported;
- disconnect.

The adapter may map vendor/framework events into Twring events, but must not reinterpret the agent's intent or call the agent's tools itself.

## UI rules

- The active call screen is calm and minimal.
- Never expose internal protocol jargon to ordinary users.
- Show meaningful activity states such as “Checking calendar…” or “Working…” when the connected agent supplies them.
- Animations must be interruptible, performant, and respect reduced-motion settings.
- Every critical state needs accessible text; color/animation alone is insufficient.
- Failure states must always give a clear next action.

## Testing expectations

For code changes, add or update the smallest meaningful test layer:

- pure logic → unit test;
- adapter mapping → contract/integration test;
- gateway protocol → integration test;
- call state transition → deterministic state-machine test;
- high-risk user path → E2E/device test where supported.

Before claiming completion:

1. run formatter/linter;
2. run TypeScript checks;
3. run relevant unit/integration tests;
4. run the smallest app/gateway smoke test possible;
5. report what was not run and why.

Do not “fix” failing unrelated tests unless the task requests it; identify them separately.

## Work style

For non-trivial tasks:

1. inspect relevant docs and code;
2. state a short implementation plan in the work log/task response;
3. implement vertically rather than scattering placeholders;
4. run checks;
5. self-review diff against acceptance criteria;
6. update docs only when behavior/contracts changed;
7. leave the repository runnable.

Do not spend a turn asking questions when the documented product behavior makes the answer clear. Make a reasonable implementation choice consistent with the docs and record it when consequential.

## Git/worktree coordination

When multiple agents work concurrently:

- one task = one branch/worktree;
- do not edit files owned by another active task without coordination;
- prefer task boundaries that minimize overlap;
- merge shared-contract changes before dependent implementations where practical;
- never force-push another agent's branch;
- keep commits scoped and descriptive.
- Commits carry a DCO sign-off (`git commit -s`).

See `docs/ORCHESTRATION.md`.

## Definition of done

A task is done only when:

- acceptance criteria are met;
- relevant tests pass;
- typing/lint passes for touched packages;
- expected failure states are handled;
- no secrets or debug artifacts were committed;
- Android behavior is validated when the task touches mobile runtime;
- iOS compatibility is preserved or a documented platform exception exists;
- docs/contracts are updated if public behavior changed;
- no TODO is left for a requirement that was part of the task.

## Things Codex should actively resist

- rewriting working architecture to a fashionable alternative;
- making the mobile app depend directly on Deepgram secret credentials;
- coupling UI components to provider event shapes;
- introducing a second agent brain in the voice gateway;
- building “future scale” before measured need;
- waiting for full agent responses before starting TTS;
- hiding long tool calls behind a frozen waveform;
- treating reconnect as a brand-new turn if a resumable session exists;
- shipping Android-only APIs directly through shared feature code without an adapter.

## Documentation maintenance

When making an architectural decision, update `docs/DECISIONS.md` with:

- date;
- decision;
- context;
- alternatives considered;
- consequences;
- rollback/migration note.

Keep this file concise. Detailed explanations belong in `docs/`.
