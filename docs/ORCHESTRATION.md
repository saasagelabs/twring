# Twring Codex + Claude Code Orchestration

## 1. Goal

Use both coding agents without duplicate work, architecture drift, conflicting diffs, or oversized unreviewable changes.

Shared source of truth:

```text
docs/*
```

Model-specific repo instructions:

```text
AGENTS.md
CLAUDE.md
```

## 2. Core rule

**One task has one implementation owner.**

The other model may review, test, or implement a non-overlapping task.

Never ask two agents to independently implement the same feature into the same branch.

## 3. Default work allocation

These are workflow defaults, not capability rankings.

### Claude Code often leads

- architecture-heavy vertical slices;
- multi-package feature work;
- complex debugging;
- substantial refactors;
- voice pipeline integration;
- state-machine integration;
- cross-cutting native/mobile work.

### Codex often leads

- well-scoped implementation;
- tests;
- bug fixes;
- APIs;
- adapter implementation;
- review;
- isolated UI;
- hardening/follow-ups.

Either can own any task when context/availability favors it.

## 4. Branch/worktree model

```text
main
  ├─ feat/<task-id>-...
  ├─ fix/<task-id>-...
  └─ chore/<task-id>-...
```

Concurrent work uses separate worktrees/branches.

## 5. Task lifecycle

```text
BACKLOG → READY → ASSIGNED → IMPLEMENTING → SELF-REVIEW → PEER-REVIEW → MERGE → VERIFIED
```

## 6. Task packet

Every implementation task states:

- goal;
- user outcome;
- owner;
- relevant docs;
- file scope if useful;
- acceptance criteria;
- out of scope;
- tests;
- dependencies.

Use `TASK_TEMPLATE.md`.

## 7. Claude → Codex review handoff example

```text
TWR-014 implemented on feat/TWR-014-call-state.

Review only:
- state transitions
- cancellation correctness
- illegal-transition tests

Do not refactor architecture.
Run:
pnpm --filter contracts test
pnpm --filter gateway test
```

Avoid “review everything and improve it.”

## 8. Codex → Claude handoff

For cross-cutting issue include:

- exact failing behavior;
- relevant files;
- logs/tests;
- suspected invariant;
- work already tried.

## 9. Shared contract changes

For contracts/state/auth/adapter schema, merge the shared contract change before parallel dependent work when practical.

Do not let two agents independently edit the same discriminated union.

## 10. Documentation authority

If code and docs conflict:

- clear code bug → fix code;
- real product change → update docs + code together;
- unclear → choose minimal safe interpretation and record a decision/task.

Do not rewrite docs merely to rationalize accidental implementation.

## 11. Architecture decisions

One owner authors the ADR/decision. Second agent reviews it before broad refactor when an invariant changes.

## 12. Review checklist

Reviewer asks:

- acceptance criteria met?
- Twring invariants preserved?
- unrequested scope?
- duplicated provider logic?
- reconnect/action duplication risk?
- secrets safe?
- cancellation correct?
- Android code iOS-friendly?
- tests meaningful?
- solution simpler than necessary?

## 13. Conflict avoidance

Before work, inspect branch/status and pull/rebase according to team workflow.

High-overlap tasks state intended files.

## 14. Founder-friendly workflow

Project owner should be able to say:

> Build TWR-021.

Agent reads the task and referenced docs without asking the owner to restate architecture.

## 15. Build captain

Each milestone has one build captain/session responsible for integration, full checks, build-order update, blockers, and next task packets.

Never have two simultaneous captains.

## 16. Context hygiene

Do not load all docs for every task.

UI task: task + UX + design + relevant code.

Voice task: architecture + voice + state + adapter + task.

## 17. Handoff artifacts

Use observable artifacts:

- diff;
- tests;
- logs;
- decision record;
- concise handoff note.

Do not depend on private chain-of-thought from another model.

## 18. Safe parallelization

Good:

```text
Claude: LiveKit gateway room/session
Codex: agent setup screens
Codex: fake adapter harness
```

Bad:

```text
Claude: redesign AgentEvent
Codex: build adapter against old AgentEvent
```

Sequence shared contract changes first.

## 19. Repeated-failure escalation

If two review rounds fail the same acceptance criterion:

- stop incremental patching;
- inspect root architecture/state;
- assign one owner;
- add a regression test.

## 20. Completion report

Owner reports:

```text
Implemented:
Tests:
Device/build checks:
Known limitations:
Follow-up:
```

No vague “should work.”

## 21. Anti-patterns

Do not:

- ask both models to “make it production ready” on the same branch;
- let reviewer rewrite the whole feature;
- merge unrelated refactors;
- create new planning scratch files every session;
- let architecture drift based on whichever model edited last.
