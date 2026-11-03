// Adapted from apps/gateway/src/rate-limit.ts (the relay must not import from the gateway): a full
// table evicts its oldest entry instead of refusing every new client.

/**
 * Fixed-window request limiter keyed by client (the person, or the address before sign-in). In-memory and
 * per-process, which matches the single-process V1 deployment (TWR-006).
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** Monotonic by default: a wall-clock step backwards must not freeze every window. */
    private readonly now: () => number = () => performance.now(),
    /** Bound memory under a flood of distinct keys. */
    private readonly maxKeys = 10_000,
  ) {}

  /** Records one attempt; false means the caller is over the limit for this window. */
  tryAcquire(key: string): boolean {
    const now = this.now();
    const window = this.windows.get(key);
    if (window === undefined || now - window.startedAt >= this.windowMs) {
      if (this.windows.size >= this.maxKeys) this.evictExpired(now);
      // Still full: forget the oldest client rather than refusing every new one.
      if (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next();
        if (oldest.done !== true) this.windows.delete(oldest.value);
      }
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (window.count >= this.limit) return false;
    window.count += 1;
    return true;
  }

  /** Whether one more attempt would be allowed now, without recording it. */
  allows(key: string): boolean {
    const window = this.windows.get(key);
    return (
      window === undefined ||
      this.now() - window.startedAt >= this.windowMs ||
      window.count < this.limit
    );
  }

  private evictExpired(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }
}
