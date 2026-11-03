/**
 * The limiter key for a request: the signed-in person when there is one, so people behind one
 * address (an office, a mobile carrier) do not share a budget (review finding 6); the address
 * otherwise. `userFor` throws on a request that was not authenticated.
 */
export function rateKey(request: { ip: string }, userFor?: (request: never) => string): string {
  if (userFor !== undefined) {
    try {
      return `user:${(userFor as (request: { ip: string }) => string)(request)}`;
    } catch {
      // Not signed in: fall back to the address.
    }
  }
  return `ip:${request.ip}`;
}

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
      if (this.windows.size >= this.maxKeys) return false;
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (window.count >= this.limit) return false;
    window.count += 1;
    return true;
  }

  /** Whether `key` could still acquire in this window, without recording an attempt. */
  hasRoom(key: string): boolean {
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
