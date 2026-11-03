import { describe, expect, it } from 'vitest';

import { FixedWindowLimiter } from './rate-limit';

describe('FixedWindowLimiter', () => {
  it('allows up to the limit per key per window, then resets', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(2, 60_000, () => now);
    expect([limiter.tryAcquire('a'), limiter.tryAcquire('a'), limiter.tryAcquire('a')]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limiter.tryAcquire('b')).toBe(true);
    now = 60_000;
    expect(limiter.tryAcquire('a')).toBe(true);
  });

  it('a fixed window: refusals do not extend it, and it resets exactly at its end', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 60_000, () => now);
    expect(limiter.tryAcquire('a')).toBe(true);
    now = 30_000;
    expect(limiter.tryAcquire('a')).toBe(false);
    now = 59_999;
    expect(limiter.tryAcquire('a')).toBe(false);
    now = 60_000;
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
  });

  it('by default counts time on a clock that a wall-clock step backwards cannot freeze', () => {
    const realNow = Date.now;
    let wall = realNow();
    Date.now = () => wall;
    try {
      const limiter = new FixedWindowLimiter(1, 50);
      expect(limiter.tryAcquire('a')).toBe(true);
      // The system clock is stepped back an hour (NTP, VM resume)...
      wall -= 3_600_000;
      const started = performance.now();
      while (performance.now() - started < 60) {
        // ...and a little more than one window of real time passes.
      }
      expect(limiter.tryAcquire('a')).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it('fails closed when too many distinct keys are live, and recovers when they expire', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(5, 1000, () => now, 2);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('b')).toBe(true);
    expect(limiter.tryAcquire('c')).toBe(false);
    now = 1000;
    expect(limiter.tryAcquire('c')).toBe(true);
  });
});
