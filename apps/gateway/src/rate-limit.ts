import { isIPv4, isIPv6 } from 'node:net';

/**
 * The key per-address limits count under: the whole address for IPv4 (IPv4-mapped IPv6 included),
 * the /64 for IPv6, since one host is usually handed a whole /64 to pick addresses from.
 */
export function ipKey(ip: string): string {
  const address = ip.trim().replace(/%.*$/, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  if (!isIPv6(address)) return address;
  let text = address;
  // A dotted tail (`::1.2.3.4`) is the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    const hex = (hi: number, lo: number) => ((hi << 8) | lo).toString(16);
    text = `${text.slice(0, dotted.index)}${hex(a, b)}:${hex(c, d)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  const prefix = groups.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

/**
 * The limiter key for a request: the signed-in person when there is one, so people behind one
 * address (an office, a mobile carrier) do not share a budget (review finding 6); the address
 * otherwise, by `ipKey` (an IPv6 /64 is one client). `userFor` throws on a request that was not
 * authenticated.
 */
export function rateKey(request: { ip: string }, userFor?: (request: never) => string): string {
  if (userFor !== undefined) {
    try {
      return `user:${(userFor as (request: { ip: string }) => string)(request)}`;
    } catch {
      // Not signed in: fall back to the address.
    }
  }
  return `ip:${ipKey(request.ip)}`;
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
    /** Bound memory under a flood of distinct keys; past it the oldest is forgotten. */
    private readonly maxKeys = 10_000,
  ) {}

  /** Records one attempt; false means the caller is over the limit for this window. */
  tryAcquire(key: string): boolean {
    const now = this.now();
    const window = this.windows.get(key);
    if (window === undefined || now - window.startedAt >= this.windowMs) {
      // Re-added at the end, so the table stays ordered oldest window first.
      this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) this.evictExpired(now);
      // Still full: forget the oldest client rather than refuse every new one (a flood of
      // addresses must not lock everyone out).
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
