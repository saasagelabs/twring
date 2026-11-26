/** Last sign of life per private turn (ADR-045): in memory; a restart interrupts in-flight turns. */
export class PrivateIdle {
  private readonly turns = new Map<string, { userId: string; agentId: string; last: number }>();

  constructor(
    private readonly idleMs: number,
    private readonly now: () => number = Date.now,
    private readonly cap = 10_000,
  ) {}

  touch(turnId: string, userId: string, agentId: string): void {
    this.turns.delete(turnId);
    this.turns.set(turnId, { userId, agentId, last: this.now() });
    if (this.turns.size > this.cap) {
      const oldest = this.turns.keys().next().value;
      if (oldest !== undefined) this.turns.delete(oldest);
    }
  }

  tracks(turnId: string): boolean {
    return this.turns.has(turnId);
  }

  end(turnId: string): void {
    this.turns.delete(turnId);
  }

  /** Turns silent for longer than the limit; each is reported once and forgotten. */
  stale(): { turnId: string; userId: string; agentId: string }[] {
    const cutoff = this.now() - this.idleMs;
    const out: { turnId: string; userId: string; agentId: string }[] = [];
    for (const [turnId, t] of this.turns)
      if (t.last < cutoff) {
        out.push({ turnId, userId: t.userId, agentId: t.agentId });
        this.turns.delete(turnId);
      }
    return out;
  }
}
