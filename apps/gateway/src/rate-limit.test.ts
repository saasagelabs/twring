import { describe, expect, it } from 'vitest';

import { FixedWindowLimiter, ipKey, rateKey } from './rate-limit';

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

  it('a full table forgets its oldest client instead of refusing new ones', () => {
    const limiter = new FixedWindowLimiter(1, 1000, () => 0, 2);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('b')).toBe(true);
    // Full, nothing expired: a new client still gets in, and the oldest ('a') is forgotten.
    expect(limiter.tryAcquire('c')).toBe(true);
    expect(limiter.tryAcquire('b')).toBe(false);
    expect(limiter.tryAcquire('c')).toBe(false);
    expect(limiter.tryAcquire('a')).toBe(true);
  });

  it('expired windows go first, before any live client is forgotten', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 1000, () => now, 2);
    expect(limiter.tryAcquire('a')).toBe(true);
    now = 500;
    expect(limiter.tryAcquire('b')).toBe(true);
    now = 1000; // 'a' has expired, 'b' has not
    expect(limiter.tryAcquire('c')).toBe(true);
    expect(limiter.tryAcquire('b')).toBe(false);
  });

  it('a renewed window counts as the newest, so it is not the next one forgotten', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 1000, () => now, 2);
    expect(limiter.tryAcquire('a')).toBe(true);
    now = 400;
    expect(limiter.tryAcquire('b')).toBe(true);
    now = 1000;
    expect(limiter.tryAcquire('a')).toBe(true); // renewed: now newer than 'b'
    now = 1100;
    expect(limiter.tryAcquire('c')).toBe(true); // full: forgets 'b', the oldest
    expect(limiter.tryAcquire('a')).toBe(false);
    expect(limiter.tryAcquire('b')).toBe(true);
  });

  it('10,000 live clients do not lock out the next one', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, () => 0);
    for (let i = 0; i < 10_000; i += 1) {
      expect(limiter.tryAcquire(`ip:10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`)).toBe(
        true,
      );
    }
    expect(limiter.tryAcquire('ip:203.0.113.9')).toBe(true);
    expect(limiter.tryAcquire('ip:203.0.113.9')).toBe(false);
  });
});

describe('rateKey', () => {
  it('keys a signed-in person by their account, whatever their address', () => {
    expect(rateKey({ ip: '2001:db8::1' }, () => 'u1')).toBe('user:u1');
  });

  it('keys by the address before sign-in: IPv6 by its /64, IPv4-mapped as IPv4', () => {
    const notSignedIn = () => {
      throw new Error('not signed in');
    };
    expect(rateKey({ ip: '203.0.113.9' }, notSignedIn)).toBe('ip:203.0.113.9');
    expect(rateKey({ ip: '::ffff:203.0.113.9' })).toBe('ip:203.0.113.9');
    expect(rateKey({ ip: '2001:db8:1:2::9' })).toBe('ip:2001:db8:1:2::/64');
    expect(rateKey({ ip: '2001:db8:1:2:ffff::1' })).toBe(rateKey({ ip: '2001:db8:1:2::9' }));
    expect(rateKey({ ip: '2001:db8:1:3::9' })).not.toBe(rateKey({ ip: '2001:db8:1:2::9' }));
  });

  it('one /64 shares one budget, a different /64 has its own', () => {
    const limiter = new FixedWindowLimiter(2, 60_000, () => 0);
    const take = (ip: string) => limiter.tryAcquire(rateKey({ ip }));
    expect([take('2001:db8:1:2::1'), take('2001:db8:1:2::2'), take('2001:db8:1:2::3')]).toEqual([
      true,
      true,
      false,
    ]);
    expect(take('2001:db8:1:3::1')).toBe(true);
    expect(ipKey('::FFFF:198.51.100.20')).toBe('198.51.100.20');
  });
});
