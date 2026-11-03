import { agentEventSchema, type AgentEvent } from '@twring/contracts';

/** A whole reply longer than this is treated as a runaway stream (SECURITY: bounded payloads). */
export const MAX_AGENT_TURN_TEXT_CHARS = 20_000;
export const MAX_TEXT_TURN_TEXT_CHARS = 100_000;

export type GuardResult =
  | { kind: 'event'; event: AgentEvent }
  /** Expected noise: dropped silently. */
  | { kind: 'ignored'; reason: 'other_turn' | 'duplicate' | 'after_done' }
  /** The stream can no longer be trusted; the turn fails instead of inventing order (§8). */
  | { kind: 'violation'; reason: 'malformed' | 'seq_regressed' | 'too_long' };

/**
 * Enforces AGENT_ADAPTER_SPEC §8 on one turn's event stream: events for other turns, duplicate
 * `event_id`s, and anything after `done` are dropped; an event that fails the contract schema
 * (including its size bounds), a `seq` that goes backwards, or a reply that grows past the size
 * bound fails the turn.
 */
export class AgentStreamGuard {
  private readonly seen = new Set<string>();
  private lastSeq = -1;
  private textChars = 0;
  private done = false;

  constructor(
    private readonly turnId: string,
    private readonly maxTextChars = MAX_AGENT_TURN_TEXT_CHARS,
  ) {}

  accept(event: AgentEvent): GuardResult {
    // Adapters are external code: re-check the contract here rather than trust their typing.
    if (!agentEventSchema.safeParse(event).success)
      return { kind: 'violation', reason: 'malformed' };
    if (event.turn_id !== this.turnId) return { kind: 'ignored', reason: 'other_turn' };
    if (this.done) return { kind: 'ignored', reason: 'after_done' };
    if (this.seen.has(event.event_id)) return { kind: 'ignored', reason: 'duplicate' };
    if (event.seq !== undefined) {
      if (event.seq <= this.lastSeq) return { kind: 'violation', reason: 'seq_regressed' };
      this.lastSeq = event.seq;
    }
    this.seen.add(event.event_id);
    if (event.type === 'text.delta') {
      this.textChars += event.delta.length;
      if (this.textChars > this.maxTextChars) return { kind: 'violation', reason: 'too_long' };
    }
    if (event.type === 'done') this.done = true;
    return { kind: 'event', event };
  }
}
