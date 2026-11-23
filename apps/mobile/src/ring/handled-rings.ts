/** How long a handled invite stays remembered: longer than any ring, so late pushes stay quiet. */
export const HANDLED_RING_TTL_MS = 2 * 60_000;

/**
 * Invites this app run already showed, answered, declined or saw cancelled. FCM can deliver a ring
 * twice, or late after its cancel; such a repeat must not open the incoming-call screen again.
 * Android also keeps a persisted copy natively (Ring.kt), which covers pushes with no JS running.
 */
export class HandledRings {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = HANDLED_RING_TTL_MS,
  ) {}

  mark(inviteId: string): void {
    this.prune();
    this.seen.set(inviteId, this.now());
  }

  has(inviteId: string): boolean {
    this.prune();
    return this.seen.has(inviteId);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, at] of this.seen) if (now - at >= this.ttlMs) this.seen.delete(id);
  }
}
